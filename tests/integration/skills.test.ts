// ABOUTME: Integration tests for the skill:// resources: the five vendored Steel skills served as
// ABOUTME: markdown over plain resources primitives, with reads routed and errors asserted.
import { Client } from '@modelcontextprotocol/client';
import {
    CLIENT_CAPABILITIES_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createSteelMcpServer } from '../../src/core/server.js';
import { SKILL_CATALOG } from '../../src/core/skills/catalog.generated.js';
import { createSteelHttpHandler } from '../../src/http.js';
import { TEST_API_KEY, testDeps } from '../helpers/fakes.js';

type Deps = ReturnType<typeof testDeps>;

interface Harness {
    client: Client;
    close(): Promise<void>;
}

const open: Harness[] = [];

async function connect(deps: Deps = testDeps()): Promise<Harness> {
    const server = createSteelMcpServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const harness: Harness = {
        client,
        close: async () => {
            await client.close();
            await server.close();
        },
    };
    open.push(harness);
    return harness;
}

afterEach(async () => {
    while (open.length) await open.pop()?.close();
});

/** Collects every resource the server lists, following the cursor if the server paginates. */
async function listAllResources(client: Client) {
    const resources = [];
    let cursor: string | undefined;
    do {
        const page = await client.listResources(cursor ? { cursor } : undefined);
        resources.push(...page.resources);
        cursor = page.nextCursor;
    } while (cursor);
    return resources;
}

const SKILL_NAMES = [
    'steel-browser',
    'steel-developer',
    'steel-reliability',
    'steel-session-debugging',
    'steel-skill-creator',
] as const;

const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** The text of one resource content item; skill resources never serve the blob variant. */
function textOfContent(content: unknown): string {
    if (typeof content !== 'object' || content === null || !('text' in content)) {
        throw new Error('skill resource served a non-text content item');
    }
    return (content as { text?: unknown }).text as string;
}

/** Reads one skill resource over the hosted HTTP boundary on the modern era, where cache hints ride. */
async function modernRead(uri: string) {
    const handler = createSteelHttpHandler({
        allowedHostnames: ['mcp.steel.dev'],
        allowedOriginHostnames: ['steel.dev'],
        depsForRequest: () => testDeps(),
    });
    try {
        const response = await handler.fetch(
            new Request('https://mcp.steel.dev/mcp', {
                method: 'POST',
                headers: {
                    host: 'mcp.steel.dev',
                    authorization: `Bearer ${TEST_API_KEY}`,
                    accept: 'application/json',
                    'content-type': 'application/json',
                    'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
                    'mcp-method': 'resources/read',
                    'mcp-name': uri,
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'resources/read',
                    params: {
                        uri,
                        _meta: {
                            [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
                            [CLIENT_CAPABILITIES_META_KEY]: {},
                        },
                    },
                }),
            })
        );
        const body = (await response.json()) as {
            result?: { contents?: Array<{ text?: string }>; ttlMs?: number; cacheScope?: string };
        };
        if (!body.result) throw new Error(`resources/read failed: ${JSON.stringify(body)}`);
        return body.result;
    } finally {
        await handler.close();
    }
}

describe('the skill resources', () => {
    it('list every vendored skill under its skill:// SKILL.md URI as markdown', async () => {
        const harness = await connect();
        const resources = await listAllResources(harness.client);

        for (const name of SKILL_NAMES) {
            const entry = resources.find(resource => resource.uri === `skill://${name}/SKILL.md`);
            expect(entry, `${name} is missing from resources/list`).toBeDefined();
            expect(entry?.mimeType).toBe('text/markdown');
            expect(entry?.description).toContain('Use this skill');
        }
    });

    it('serve the catalog bodies byte for byte', async () => {
        const harness = await connect();
        const entry = SKILL_CATALOG.find(file => file.path === 'steel-browser/SKILL.md');
        expect(entry).toBeDefined();

        const result = await harness.client.readResource({ uri: 'skill://steel-browser/SKILL.md' });
        expect(result.contents[0]).toMatchObject({
            uri: 'skill://steel-browser/SKILL.md',
            mimeType: 'text/markdown',
            text: entry?.text,
        });
    });

    it('reach nested reference files under the same skill:// root', async () => {
        const harness = await connect();
        const result = await harness.client.readResource({
            uri: 'skill://steel-browser/references/troubleshooting.md',
        });
        expect(result.contents[0]?.mimeType).toBe('text/markdown');
        expect(textOfContent(result.contents[0])).toContain('#');
    });

    it('list and read every skill:// resource, so no catalog file is stranded behind a bad mapping', async () => {
        const harness = await connect();
        const resources = await listAllResources(harness.client);
        const skillUris = resources
            .filter(resource => resource.uri.startsWith('skill://'))
            .map(resource => resource.uri);
        expect(skillUris.length).toBe(SKILL_CATALOG.length);

        for (const uri of skillUris) {
            const result = await harness.client.readResource({ uri });
            expect(textOfContent(result.contents[0]).length, `${uri} served empty`).toBeGreaterThan(0);
        }
    });

    it('reject a skill URI the catalog does not carry, with the protocol not-found error', async () => {
        const harness = await connect();
        await expect(
            harness.client.readResource({ uri: 'skill://steel-browser/references/does-not-exist.md' })
        ).rejects.toThrow(/not found/i);
    });

    it('cache skill reads publicly for an hour, overriding the private resources/read hint', async () => {
        // Same reasoning as the session viewer: the skill bodies are build-time static and carry no
        // principal-derived bytes, so a shared cache may hold them while session reads stay private.
        const result = await modernRead('skill://steel-browser/SKILL.md');
        expect(result.ttlMs).toBe(3_600_000);
        expect(result.cacheScope).toBe('public');
    });
});
