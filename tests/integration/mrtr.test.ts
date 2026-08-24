// ABOUTME: Integration tests for the human-in-the-loop handoff driven by a real MCP client: the
// ABOUTME: input_required round, the retry that re-checks the page, and the fallback for clients without it.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ClientCapabilities } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { interactiveBlockError, toolErrorResult } from '../../src/core/errors.js';
import { HANDOFF_KEY, MAX_HANDOFF_ROUNDS } from '../../src/core/mrtr.js';
import { RedisHandleRegistry } from '../../src/core/registry-redis.js';
import { createSteelMcpServer, UI_EXTENSION_NAME } from '../../src/core/server.js';
import { createSteelHttpHandler } from '../../src/http.js';
import type { FixturePage } from '../helpers/cdp-fixture.js';
import { FakeRedis } from '../helpers/fake-redis.js';
import {
    badgedShopPage,
    captchaPage,
    FakeSteelApi,
    loginWallPage,
    plainPage,
    TEST_API_KEY,
    testDeps,
} from '../helpers/fakes.js';

const HOST = 'mcp.steel.dev';

type Deps = ReturnType<typeof testDeps>;

/** The URL-mode elicitation params the server sends, as the client receives them. */
interface UrlElicitation {
    mode?: string;
    message: string;
    url: string;
}

interface HarnessOptions {
    deps?: Deps;
    /** Declared client capabilities. Omit the elicitation url mode to model a client without it. */
    capabilities?: ClientCapabilities;
    /** `false` surfaces the raw input_required result instead of fulfilling it. */
    autoFulfill?: boolean;
    /** Stands in for the person working in the live browser. */
    onElicit?: () => void | Promise<void>;
    elicitAction?: 'accept' | 'decline';
    /** Captures server-side errors so an error-path test leaves no output behind. */
    onerror?: (error: Error) => void;
}

interface Harness {
    client: Client;
    deps: Deps;
    elicited: UrlElicitation[];
    close(): Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
    await Promise.all(open.splice(0).map(harness => harness.close()));
});

function elicitationHandler(options: HarnessOptions, elicited: UrlElicitation[]) {
    return async (request: { params: unknown }) => {
        elicited.push(request.params as UrlElicitation);
        await options.onElicit?.();
        return { action: options.elicitAction ?? 'accept' } as const;
    };
}

/** Connects a real client over the hosted fetch boundary, which is where the 2026 wire era lives. */
async function connectModern(options: HarnessOptions = {}): Promise<Harness> {
    const deps = options.deps ?? testDeps();
    const capabilities = options.capabilities ?? { elicitation: { url: {} } };
    const handler = createSteelHttpHandler({
        allowedHostnames: [HOST],
        allowedOriginHostnames: [HOST],
        depsForRequest: input => ({ ...deps, principal: input.principal }),
        onerror: options.onerror,
    });
    const elicited: UrlElicitation[] = [];
    const client = new Client(
        { name: 'test', version: '1.0.0' },
        {
            capabilities,
            versionNegotiation: { mode: 'auto' },
            ...(options.autoFulfill === false ? { inputRequired: { autoFulfill: false } } : {}),
        }
    );
    if (capabilities.elicitation !== undefined) {
        client.setRequestHandler('elicitation/create', elicitationHandler(options, elicited));
    }

    const transport = new StreamableHTTPClientTransport(new URL(`https://${HOST}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${TEST_API_KEY}` } },
        // The Host header a real deployment gets from the network, which the boundary validates.
        fetch: async (url, init) => {
            const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
            headers.set('host', HOST);
            return handler.fetch(new Request(url, { ...(init as RequestInit), headers }));
        },
    });
    await client.connect(transport);

    const harness: Harness = {
        client,
        deps,
        elicited,
        close: async () => {
            await client.close();
            await handler.close();
        },
    };
    open.push(harness);
    return harness;
}

/** Connects a real client over the 2025 wire era, where the SDK fulfils the handoff in process. */
async function connectLegacy(options: HarnessOptions = {}): Promise<Harness> {
    const deps = options.deps ?? testDeps();
    const capabilities = options.capabilities ?? { elicitation: { url: {} } };
    const server = createSteelMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const elicited: UrlElicitation[] = [];
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities });
    if (capabilities.elicitation !== undefined) {
        client.setRequestHandler('elicitation/create', elicitationHandler(options, elicited));
    }
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const harness: Harness = {
        client,
        deps,
        elicited,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
    open.push(harness);
    return harness;
}

async function newSession(harness: Harness): Promise<string> {
    const result = await harness.client.callTool({ name: 'steel_session_create', arguments: {} });
    const structured = result.structuredContent as { session_id?: string } | undefined;
    if (!structured?.session_id) throw new Error(`session_create failed: ${JSON.stringify(result.content)}`);
    return structured.session_id;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
    return (result.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('\n');
}

/** Swaps the page under a live session, which is what a person signing in actually does. */
function setPage(harness: Harness, page: ReturnType<typeof plainPage>): void {
    const steelSessionId = harness.deps.api.created[0]?.sessionId;
    harness.deps.pool.fixtureFor(steelSessionId ?? '')?.setPage(page);
}

/** The tool-execution error a client that cannot hand off gets instead. */
function expectedLoginError(url = 'https://app.test/login') {
    return toolErrorResult(
        interactiveBlockError({ kind: 'login_wall', vendor: 'credentials', marker: 'password_field' }, url, {})
    );
}

describe('explicit session handoff', () => {
    it('can pause an ordinary page for review without waiting for a detector', async () => {
        const harness = await connectModern({ deps: testDeps({ page: plainPage }), autoFulfill: false });
        const handle = await newSession(harness);
        const result = (await harness.client.callTool(
            { name: 'steel_session_handoff', arguments: { session_id: handle, reason: 'review' } },
            { allowInputRequired: true }
        )) as unknown as {
            resultType?: string;
            requestState?: string;
            inputRequests?: Record<string, { method: string; params: UrlElicitation }>;
        };

        expect(result.resultType).toBe('input_required');
        expect(result.requestState).toBeTypeOf('string');
        expect(result.inputRequests?.[HANDOFF_KEY]?.params.message).toMatch(/review the page/i);
        expect(result.inputRequests?.[HANDOFF_KEY]?.params.message).toMatch(/Hand back/i);
        expect(result.inputRequests?.[HANDOFF_KEY]?.params.message).toMatch(/accept the pending handoff prompt/i);
        expect(result.inputRequests?.[HANDOFF_KEY]?.params.url).toContain('/player');
    });

    it('preserves one cart session through handoff, hand back and explicit release', async () => {
        const cartPage = (reviewed = false) => {
            const page = plainPage();
            page.root.children = [
                ...(page.root.children ?? []),
                {
                    tag: 'DIV',
                    backendNodeId: 12,
                    role: 'StaticText',
                    name: 'Cart contains one Mario Kart bundle',
                    bounds: [100, 300, 320, 24],
                },
                ...(reviewed
                    ? [
                          {
                              tag: 'DIV',
                              backendNodeId: 13,
                              role: 'StaticText',
                              name: 'Pickup confirmed by the person',
                              bounds: [100, 340, 320, 24] as [number, number, number, number],
                          },
                      ]
                    : []),
            ];
            return page;
        };
        let harness: Harness;
        harness = await connectModern({
            deps: testDeps({ page: cartPage }),
            onElicit: () => setPage(harness, cartPage(true)),
        });
        const handle = await newSession(harness);
        const steelSessionId = harness.deps.api.created[0]!.sessionId;
        const before = await harness.client.callTool({
            name: 'steel_snapshot',
            arguments: { session_id: handle },
        });
        expect(textOf(before)).toContain('Cart contains one Mario Kart bundle');

        const result = await harness.client.callTool({
            name: 'steel_session_handoff',
            arguments: { session_id: handle, reason: 'manual_step' },
        });

        expect(result.isError).not.toBe(true);
        expect(textOf(result)).toContain('handed the browser back');
        expect(harness.elicited).toHaveLength(1);
        await expect(harness.deps.registry.resolveForAgent(handle, harness.deps.principal)).resolves.toBeTruthy();

        const after = await harness.client.callTool({
            name: 'steel_snapshot',
            arguments: { session_id: handle },
        });
        expect(textOf(after)).toContain('Cart contains one Mario Kart bundle');
        expect(textOf(after)).toContain('Pickup confirmed by the person');
        expect(harness.deps.api.created).toHaveLength(1);

        await harness.client.callTool({ name: 'steel_session_release', arguments: { session_id: handle } });
        expect(harness.deps.api.released).toEqual([steelSessionId]);
        expect(harness.deps.pool.closed).toEqual([steelSessionId]);
    });

    it('does not pin a session when the client offers no usable human-control route', async () => {
        const harness = await connectModern({ deps: testDeps({ page: plainPage }), capabilities: {} });
        const handle = await newSession(harness);
        const result = await harness.client.callTool({
            name: 'steel_session_handoff',
            arguments: { session_id: handle, reason: 'review' },
        });

        expect(result.isError).toBe(true);
        const record = await harness.deps.registry.resolve(handle, harness.deps.principal);
        expect(record.awaitingInputUntil).toBeUndefined();
    });

    it('waits on the rendered viewer instead of leaking a raw link when formal elicitation is unavailable', async () => {
        const harness = await connectModern({
            deps: testDeps({ page: plainPage }),
            capabilities: { extensions: { [UI_EXTENSION_NAME]: {} } },
        });
        const handle = await newSession(harness);
        const result = await harness.client.callTool({
            name: 'steel_session_handoff',
            arguments: { session_id: handle, reason: 'sensitive_input' },
        });

        expect(result.isError).not.toBe(true);
        expect(textOf(result)).toMatch(/existing live browser viewer/i);
        expect(textOf(result)).toMatch(/tell the agent to continue/i);
        expect(textOf(result)).not.toContain('/player');
        expect(result.structuredContent).toMatchObject({ handoff: { status: 'awaiting_human', mode: 'inline' } });
    });
});

describe('input_required for a login wall', () => {
    it('returns a URL elicitation pointing at the session player, with opaque state', async () => {
        const harness = await connectModern({ deps: testDeps({ page: loginWallPage }), autoFulfill: false });
        const handle = await newSession(harness);

        const result = (await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
            { allowInputRequired: true }
        )) as unknown as {
            resultType?: string;
            requestState?: string;
            inputRequests?: Record<string, { method: string; params: UrlElicitation }>;
        };

        expect(result.resultType).toBe('input_required');
        const embedded = result.inputRequests?.[HANDOFF_KEY];
        expect(embedded?.method).toBe('elicitation/create');
        expect(embedded?.params.mode).toBe('url');
        expect(embedded?.params.url).toMatch(/^https:\/\/api\.steel\.dev\/v1\/sessions\/[0-9a-f-]+\/player$/);
        expect(embedded?.params.message).toMatch(/sign in/i);
        expect(embedded?.params.message).toMatch(/Hand back/i);
        expect(embedded?.params.message).toMatch(/accept the pending handoff prompt/i);
        expect(result.requestState).toBeTypeOf('string');
    });

    it('does not put the Steel credential in the URL it hands to a person', async () => {
        const api = new FakeSteelApi({ debugUrl: 'https://api.steel.dev/v1/sessions/s1/player?apiKey=ste-test-key' });
        const harness = await connectModern({
            deps: testDeps({ api, page: loginWallPage }),
            autoFulfill: false,
        });
        const handle = await newSession(harness);

        const result = (await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
            { allowInputRequired: true }
        )) as unknown as { inputRequests?: Record<string, { params: UrlElicitation }> };

        const url = result.inputRequests?.[HANDOFF_KEY]?.params.url ?? '';
        expect(url).toContain('/player');
        expect(url).not.toContain(TEST_API_KEY);
        expect(url).not.toContain('apiKey');
    });

    it('names only the origin of the blocked page in the dialog a person reads', async () => {
        // The dialog opens Steel's player, not this URL, so page-written prose in it is a phishing
        // line in a window a person trusts. Only the origin is named, and nothing invisible.
        const phishing = 'https://evil.test/Your-session-expired-sign-in-again-at-evil-​test?next=https://real.test';
        const harness = await connectModern({
            deps: testDeps({ page: () => loginWallPage(phishing) }),
            autoFulfill: false,
        });
        const handle = await newSession(harness);

        const result = (await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: phishing } },
            { allowInputRequired: true }
        )) as unknown as { inputRequests?: Record<string, { params: UrlElicitation }> };

        const message = result.inputRequests?.[HANDOFF_KEY]?.params.message ?? '';
        expect(message).toContain('https://evil.test.');
        expect(message).not.toContain('Your-session-expired');
        expect(message).not.toContain('real.test');
        expect(message).not.toContain('​');
    });

    it('stops offering handoffs to a client that never echoes the state back', async () => {
        // The round counter the client holds bounds only a client that returns it. The server keeps
        // its own count per handle, so omitting the state buys no extra prompts.
        const harness = await connectModern({ deps: testDeps({ page: loginWallPage }), autoFulfill: false });
        const handle = await newSession(harness);
        const call = { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } };

        const results: Array<{ resultType?: string; isError?: boolean }> = [];
        for (let attempt = 0; attempt <= MAX_HANDOFF_ROUNDS; attempt++) {
            results.push(
                (await harness.client.callTool(call, { allowInputRequired: true })) as unknown as {
                    resultType?: string;
                    isError?: boolean;
                }
            );
        }

        expect(results.filter(result => result.resultType === 'input_required')).toHaveLength(MAX_HANDOFF_ROUNDS);
        expect(results.at(-1)?.isError).toBe(true);
    });

    it('stops offering handoffs however the retries are routed across replicas', async () => {
        // Round-robin routing with no sticky sessions is the hosted shape, so the whole stack has to
        // hold the bound when consecutive calls are served by different servers over a shared store.
        // What this pins is that the bound comes from the handle rather than from the signed state,
        // which is absent here. That the count is shared through the store rather than held per
        // process is proven in registry-redis.test.ts instead: two servers in one Node process would
        // share a module-scope counter, so this test could not tell the two apart.
        const store = new FakeRedis();
        const shared = () => new RedisHandleRegistry({ commands: store, releaseSteelSession: async () => {} });
        const env = { STEEL_REQUEST_STATE_SECRET: 'x'.repeat(48) };
        const first = await connectModern({
            deps: testDeps({ page: loginWallPage, registry: shared(), env }),
            autoFulfill: false,
        });
        const second = await connectModern({
            deps: testDeps({ page: loginWallPage, registry: shared(), env }),
            autoFulfill: false,
        });
        const handle = await newSession(first);

        const results: Array<{ resultType?: string; isError?: boolean }> = [];
        for (let attempt = 0; attempt <= MAX_HANDOFF_ROUNDS; attempt++) {
            const replica = attempt % 2 === 0 ? first : second;
            results.push(
                (await replica.client.callTool(
                    { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
                    { allowInputRequired: true }
                )) as unknown as { resultType?: string; isError?: boolean }
            );
        }

        expect(results.filter(result => result.resultType === 'input_required')).toHaveLength(MAX_HANDOFF_ROUNDS);
        expect(results.at(-1)?.isError).toBe(true);
    });

    it('holds the handle out of the idle sweep while the elicitation is outstanding', async () => {
        const harness = await connectModern({ deps: testDeps({ page: loginWallPage }), autoFulfill: false });
        const handle = await newSession(harness);
        await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
            { allowInputRequired: true }
        );

        // Nothing has touched the handle since, and a sweep with a zero idle budget is what the
        // shutdown path runs — the browser a person is standing in front of must survive it.
        expect(await harness.deps.registry.reap({ idleMs: 0 })).toBe(0);
        await expect(harness.deps.registry.resolve(handle, harness.deps.principal)).resolves.toBeTruthy();
    });
});

describe('the retry after a person has finished', () => {
    it('completes the original call once the page is actually clear', async () => {
        let harness: Harness;
        harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            onElicit: () => setPage(harness, plainPage()),
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('### Change');
        expect(textOf(result)).toContain('https://example.com/');
    });

    it('asks again rather than trusting the client, when the page is still blocked', async () => {
        // The person reported success and the page says otherwise; the page wins every time.
        const harness = await connectModern({ deps: testDeps({ page: loginWallPage }) });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(MAX_HANDOFF_ROUNDS);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(textOf(expectedLoginError()));
    });

    it('does not ask twice when the person declined', async () => {
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            elicitAction: 'decline',
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(textOf(expectedLoginError()));
    });
});

/**
 * A cart page whose coupon button raises an inline challenge, and the same page once it is cleared.
 *
 * The button keeps its node and its document across the two states, so the retried click resolves
 * the same `@eN` it did the first time — which is what makes re-running the action meaningful.
 */
function cartPage(withChallenge: boolean): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: 'Cart',
            bounds: [0, 0, 1280, 720],
            children: [
                { tag: 'BUTTON', backendNodeId: 10, role: 'button', name: 'Apply coupon', bounds: [100, 200, 80, 40] },
                ...(withChallenge
                    ? [
                          {
                              tag: 'DIV',
                              backendNodeId: 31,
                              role: 'checkbox',
                              name: "I'm not a robot",
                              bounds: [100, 300, 300, 74] as [number, number, number, number],
                          },
                      ]
                    : []),
            ],
        },
        url: 'https://shop.test/cart',
        title: 'Cart',
        loaderId: 'loader-cart',
    };
}

describe('the tools that can hit a wall', () => {
    it('hands off after two no-op clicks without replaying either click after hand-back', async () => {
        const harness = await connectModern({ deps: testDeps({ page: plainPage }) });
        const handle = await newSession(harness);
        const steelSessionId = harness.deps.api.created[0]!.sessionId;
        await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });
        const fixture = harness.deps.pool.fixtureFor(steelSessionId)!;

        const first = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });
        expect(first.isError).toBeFalsy();
        expect(textOf(first)).toMatch(/nothing changed/i);

        const handedBack = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });

        expect(handedBack.isError).toBeFalsy();
        expect(textOf(handedBack)).toMatch(/handed the browser back/i);
        expect(harness.elicited).toHaveLength(1);
        expect(harness.deps.api.created).toHaveLength(1);
        expect(fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(4);
    });

    it('hands off a repeatedly unstable click on the same session without replaying it after hand-back', async () => {
        const harness = await connectModern({ deps: testDeps({ page: plainPage }) });
        const handle = await newSession(harness);
        const steelSessionId = harness.deps.api.created[0]!.sessionId;
        await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });
        const fixture = harness.deps.pool.fixtureFor(steelSessionId)!;
        fixture.stub('DOM.getNodeForLocation', () => {
            throw new Error('DOM.getNodeForLocation failed: No node found at given location');
        });

        const first = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });
        expect(first.isError).toBe(true);

        const handedBack = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });

        expect(handedBack.isError).toBeFalsy();
        expect(textOf(handedBack)).toMatch(/handed the browser back/i);
        expect(harness.elicited).toHaveLength(1);
        expect(harness.deps.api.created).toHaveLength(1);
        expect(fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
    });

    it('preserves the repeated-click error when the client has no handoff route', async () => {
        const harness = await connectModern({ deps: testDeps({ page: plainPage }), capabilities: {} });
        const handle = await newSession(harness);
        const steelSessionId = harness.deps.api.created[0]!.sessionId;
        await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });
        const fixture = harness.deps.pool.fixtureFor(steelSessionId)!;
        fixture.stub('DOM.getNodeForLocation', () => ({}));

        await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });
        const repeated = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });

        expect(repeated.isError).toBe(true);
        expect(textOf(repeated)).toMatch(/still unstable.*do not retry/is);
        expect(repeated.structuredContent).toMatchObject({
            error: { code: 'click_blocked', details: { handoff_required: true } },
        });
        expect(fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(0);
    });

    it('waits once for managed credential injection before handing off a remaining login wall', async () => {
        let harness: Harness;
        let graceCalls = 0;
        const deps = testDeps({ page: loginWallPage });
        deps.credentialGrace = async () => {
            graceCalls += 1;
        };
        harness = await connectModern({
            deps,
            onElicit: () => setPage(harness, plainPage()),
        });
        const created = await harness.client.callTool({
            name: 'steel_session_create',
            arguments: { namespace: 'managed' },
        });
        const handle = (created as { structuredContent?: { session_id?: string } }).structuredContent?.session_id;
        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/login' },
        });
        expect(graceCalls).toBe(1);
        expect(harness.elicited).toHaveLength(1);
        expect(result.isError).toBeFalsy();
    });

    it('hands off a challenge a navigation landed on, naming the widget and not the page text', async () => {
        let harness: Harness;
        harness = await connectModern({
            deps: testDeps({ page: captchaPage }),
            onElicit: () => setPage(harness, plainPage()),
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://shop.test/cart' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(harness.elicited[0]?.message).toMatch(/reCAPTCHA challenge/);
        expect(harness.elicited[0]?.message).not.toContain("I'm not a robot");
        expect(result.isError).toBeFalsy();
    });

    it('hands off a challenge an action raised, then re-runs the action on the cleared page', async () => {
        let harness: Harness;
        harness = await connectModern({
            deps: testDeps({ page: () => cartPage(true) }),
            onElicit: () => setPage(harness, cartPage(false)),
        });
        const handle = await newSession(harness);
        await harness.client.callTool({ name: 'steel_snapshot', arguments: { session_id: handle } });

        const result = await harness.client.callTool({
            name: 'steel_act',
            arguments: { session_id: handle, action: 'click', target: '@e1' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(result.isError).toBeFalsy();
        // The same ref, resolved again on the cleared page, so the action really did re-run.
        expect(textOf(result)).toContain('Clicked @e1');
    });

    it('hands off when a wait ran out because a sign-in page is in the way', async () => {
        let harness: Harness;
        harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            onElicit: () => setPage(harness, plainPage()),
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_wait_for',
            arguments: { session_id: handle, text: 'Save', timeout_ms: 50 },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toMatch(/it happened/);
    });

    it('reports an unrelated wait timeout unchanged, with no handoff', async () => {
        const harness = await connectModern({ deps: testDeps({ page: plainPage }) });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_wait_for',
            arguments: { session_id: handle, text: 'Never', timeout_ms: 50 },
        });

        expect(harness.elicited).toHaveLength(0);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('Never');
    });

    it('returns the page for a working site whose footer merely carries a reCAPTCHA badge', async () => {
        const harness = await connectModern({ deps: testDeps({ page: badgedShopPage }) });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://shop.test/products' },
        });

        expect(harness.elicited).toHaveLength(0);
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('Opened https://shop.test/products');
    });

    it('leaves an ordinary navigation alone', async () => {
        const harness = await connectModern();
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://example.com/' },
        });

        expect(harness.elicited).toHaveLength(0);
        expect(result.isError).toBeFalsy();
    });
});

describe('steel_batch handoff boundaries', () => {
    it('stops after a completed navigation and resumes only the unrun work after explicit handoff', async () => {
        let harness: Harness;
        harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            onElicit: () => setPage(harness, plainPage()),
        });
        const handle = await newSession(harness);

        const blocked = await harness.client.callTool({
            name: 'steel_batch',
            arguments: {
                session_id: handle,
                steps: [
                    { tool: 'steel_navigate', arguments: { url: 'https://app.test/login' } },
                    { tool: 'steel_act', arguments: { action: 'scroll', value: '100' } },
                ],
            },
        });
        const error = (blocked.structuredContent as { error?: { details?: Record<string, unknown> } })?.error;
        expect(blocked.isError).toBe(true);
        expect(error?.details).toMatchObject({
            completed_steps: 1,
            next_step: 2,
            remaining_steps: 1,
            handoff_required: true,
        });
        expect(textOf(blocked)).toMatch(/do not rerun completed steps/i);
        expect(textOf(blocked)).toMatch(/steel_session_handoff.*same session_id/i);
        expect(harness.elicited).toHaveLength(0);

        const handedBack = await harness.client.callTool({
            name: 'steel_session_handoff',
            arguments: { session_id: handle, reason: 'manual_step' },
        });
        expect(handedBack.isError).toBeFalsy();
        expect(harness.elicited).toHaveLength(1);

        const resumed = await harness.client.callTool({
            name: 'steel_batch',
            arguments: {
                session_id: handle,
                steps: [{ tool: 'steel_act', arguments: { action: 'scroll', value: '100' } }],
            },
        });
        expect(resumed.isError).toBeFalsy();
        expect(harness.deps.api.created).toHaveLength(1);
    });

    it('does not offer handoff for a recognized block without an operable control', async () => {
        const blockedPage = () => {
            const page = loginWallPage();
            page.root.children = page.root.children?.filter(node => node.role !== 'button');
            return page;
        };
        const harness = await connectModern({ deps: testDeps({ page: blockedPage }) });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_batch',
            arguments: {
                session_id: handle,
                steps: [{ tool: 'steel_navigate', arguments: { url: 'https://app.test/login' } }],
            },
        });
        const error = (result.structuredContent as { error?: { details?: Record<string, unknown> } })?.error;
        expect(result.isError).toBe(true);
        expect(error?.details).toMatchObject({ completed_steps: 1, next_step: null, remaining_steps: 0 });
        expect(error?.details).not.toHaveProperty('handoff_required');
        expect(textOf(result)).toMatch(/human handoff is not offered/i);
    });
});

describe('graceful degradation', () => {
    it('gives a client that declared no elicitation the actionable error, unchanged', async () => {
        const harness = await connectModern({ deps: testDeps({ page: loginWallPage }), capabilities: {} });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        const expected = expectedLoginError();
        expect(result.isError).toBe(true);
        expect(result.content).toEqual(expected.content);
        expect(result.structuredContent).toEqual(expected.structuredContent);
    });

    it('gives a form-only client the same error, since url mode must be declared to be used', async () => {
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: { elicitation: { form: {} } },
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(0);
        expect(result.content).toEqual(expectedLoginError().content);
    });

    it('gives the same error when the deployment returned no live player to hand out', async () => {
        const harness = await connectModern({
            deps: testDeps({ api: new FakeSteelApi({ debugUrl: null }), page: loginWallPage }),
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(0);
        expect(result.content).toEqual(expectedLoginError().content);
    });

    it('does not pin a slot for a handoff nobody was asked to complete', async () => {
        const harness = await connectModern({ deps: testDeps({ page: loginWallPage }), capabilities: {} });
        const handle = await newSession(harness);
        await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(await harness.deps.registry.reap({ idleMs: 0 })).toBe(1);
    });
});

describe('inline viewer handoff (UI extension)', () => {
    // A host that renders the MCP-Apps inline viewer declares the UI extension per request. It is
    // also a full elicitation client, so it declares both modes; the handoff then points the person
    // at the viewer already rendered above and never emits the drivable player URL.
    const inlineCapabilities: ClientCapabilities = {
        elicitation: { form: {}, url: {} },
        extensions: { [UI_EXTENSION_NAME]: {} },
    };

    /** The form-mode elicitation params the server sends, as the client receives them. */
    interface FormElicitation {
        mode?: string;
        message: string;
        url?: string;
        requestedSchema?: unknown;
    }

    it('emits a form-mode elicitation that points at the inline viewer, not a URL', async () => {
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: inlineCapabilities,
            autoFulfill: false,
        });
        const handle = await newSession(harness);

        const result = (await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
            { allowInputRequired: true }
        )) as unknown as {
            resultType?: string;
            requestState?: string;
            inputRequests?: Record<string, { method: string; params: FormElicitation }>;
        };

        expect(result.resultType).toBe('input_required');
        const params = result.inputRequests?.[HANDOFF_KEY]?.params;
        expect(result.inputRequests?.[HANDOFF_KEY]?.method).toBe('elicitation/create');
        expect(params?.mode).toBe('form');
        expect(params?.url).toBeUndefined();
        expect(params?.requestedSchema).toBeDefined();
        expect(params?.message).toMatch(/live browser viewer above/i);
        expect(params?.message).toMatch(/Hand back/i);
        expect(params?.message).toMatch(/accept the pending handoff prompt/i);
        expect(result.requestState).toBeTypeOf('string');
    });

    it('leaves no trace of the drivable player URL anywhere in the result', async () => {
        // The external player URL is a drive-capable bearer capability. The inline path reaches the
        // same browser through the scoped CDP token the app already holds, so the URL the player
        // would have exposed must not appear at all — not in the elicitation, the opaque state, or
        // any other field. The player URL always ends in /player, so that substring is the tell.
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: inlineCapabilities,
            autoFulfill: false,
        });
        const handle = await newSession(harness);

        const result = (await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
            { allowInputRequired: true }
        )) as unknown as Record<string, unknown>;

        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('/player');
        expect(serialized).not.toContain('debugUrl');
    });

    it('completes the original call once the page is actually clear', async () => {
        let harness: Harness;
        harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: inlineCapabilities,
            onElicit: () => setPage(harness, plainPage()),
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain('### Change');
    });

    it('asks again rather than trusting the client, when the page is still blocked', async () => {
        // The person reported done and the page says otherwise; the page wins every time, exactly as
        // the external path does. The round counter on the handle, not the signed state, bounds it.
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: inlineCapabilities,
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(MAX_HANDOFF_ROUNDS);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(textOf(expectedLoginError()));
    });

    it('does not ask twice when the person declined', async () => {
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: inlineCapabilities,
            elicitAction: 'decline',
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(textOf(expectedLoginError()));
    });

    it('holds the handle out of the idle sweep while the inline elicitation is outstanding', async () => {
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: inlineCapabilities,
            autoFulfill: false,
        });
        const handle = await newSession(harness);
        await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
            { allowInputRequired: true }
        );

        expect(await harness.deps.registry.reap({ idleMs: 0 })).toBe(0);
        await expect(harness.deps.registry.resolve(handle, harness.deps.principal)).resolves.toBeTruthy();
    });
});

describe('the inline path falls back to the external player', () => {
    it('hands out the player URL, unchanged, when the client declared no UI extension', async () => {
        // A modern client with URL elicitation but no inline viewer gets byte-identical behavior to
        // before the inline path existed: a URL-mode elicitation pointing at the session player.
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            capabilities: { elicitation: { url: {} } },
            autoFulfill: false,
        });
        const handle = await newSession(harness);

        const result = (await harness.client.callTool(
            { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } },
            { allowInputRequired: true }
        )) as unknown as { inputRequests?: Record<string, { params: UrlElicitation }> };

        const params = result.inputRequests?.[HANDOFF_KEY]?.params;
        expect(params?.mode).toBe('url');
        expect(params?.url).toMatch(/^https:\/\/api\.steel\.dev\/v1\/sessions\/[0-9a-f-]+\/player$/);
    });

    it('degrades to the external player on the 2025 wire even if the UI extension was declared at connect', async () => {
        // The legacy client cannot complete the modern inline handoff contract, so URL elicitation
        // remains its compatible pause route.
        let harness: Harness;
        harness = await connectLegacy({
            deps: testDeps({ page: loginWallPage }),
            capabilities: { elicitation: { url: {} }, extensions: { [UI_EXTENSION_NAME]: {} } },
            onElicit: () => setPage(harness, plainPage()),
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(harness.elicited[0]?.url).toMatch(/\/player$/);
        expect(result.isError).toBeFalsy();
    });
});

describe('a retry carrying state the client edited', () => {
    it('is refused before any handler runs, and the reason never reaches the wire', async () => {
        const errors: Error[] = [];
        const harness = await connectModern({
            deps: testDeps({ page: loginWallPage }),
            autoFulfill: false,
            onerror: error => errors.push(error),
        });
        const handle = await newSession(harness);
        const call = { name: 'steel_navigate', arguments: { session_id: handle, url: 'https://app.test/private' } };
        const first = (await harness.client.callTool(call, { allowInputRequired: true })) as unknown as {
            requestState?: string;
        };

        // Re-seal the body with the round counter wound back, which is the edit that would buy a
        // client unlimited prompts if the state were trusted.
        const [version, body, mac] = (first.requestState ?? '').split('.');
        const decoded = JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8'));
        decoded.p.round = 0;
        const forged = [version, Buffer.from(JSON.stringify(decoded)).toString('base64url'), mac].join('.');

        const refusal = await harness.client
            .callTool(
                {
                    ...call,
                    requestState: forged,
                    inputResponses: { [HANDOFF_KEY]: { action: 'accept' } },
                } as never,
                { allowInputRequired: true }
            )
            .then(
                () => undefined,
                (error: Error) => error
            );

        // A frozen wire message: it names neither the reason, the payload, nor the session.
        expect(refusal?.message).toContain('Invalid or expired requestState');
        expect(refusal?.message).not.toContain(handle);
        expect(refusal?.message).not.toMatch(/mac|bind|expired state/);
        // Nothing was reported through the transport error hook, so the run leaves no output.
        expect(errors).toEqual([]);
    });
});

describe('the 2025 wire era', () => {
    it('serves the same handoff from the capabilities the client declared at connect', async () => {
        // A 2025-era connection carries no per-request capability envelope, so the only view of what
        // the client can do is what it declared at initialize.
        let harness: Harness;
        harness = await connectLegacy({
            deps: testDeps({ page: loginWallPage }),
            onElicit: () => setPage(harness, plainPage()),
        });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(harness.elicited).toHaveLength(1);
        expect(harness.elicited[0]?.url).toMatch(/\/player$/);
        expect(result.isError).toBeFalsy();
    });

    it('degrades to the actionable error for a 2025 client with no elicitation capability', async () => {
        const harness = await connectLegacy({ deps: testDeps({ page: loginWallPage }), capabilities: {} });
        const handle = await newSession(harness);

        const result = await harness.client.callTool({
            name: 'steel_navigate',
            arguments: { session_id: handle, url: 'https://app.test/private' },
        });

        expect(result.content).toEqual(expectedLoginError().content);
    });
});
