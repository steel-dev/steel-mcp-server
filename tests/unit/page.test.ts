// ABOUTME: Unit tests for the page controller: click hit-testing that names the covering element,
// ABOUTME: ref staleness on action, keyboard and form input, overlay dismissal and explicit waits.
import { describe, expect, it } from 'vitest';
import { SteelToolError } from '../../src/core/errors.js';
import { BrowserPage } from '../../src/core/page.js';
import { resolveSettleBudgets } from '../../src/core/settle.js';
import { type FixtureNode, type FixturePage, type FixtureSession, fixtureSession } from '../helpers/cdp-fixture.js';

const FAST_BUDGETS = { navigationWatchMs: 1, navigationMs: 5, mutationQuietMs: 1, mutationMaxMs: 5 };

function page(children: FixtureNode[], overrides: Partial<FixturePage> = {}): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: 'Example',
            bounds: [0, 0, 1280, 720],
            children,
        },
        url: 'https://example.com/',
        loaderId: 'loader-1',
        ...overrides,
    };
}

const SAVE_BUTTON: FixtureNode = {
    tag: 'BUTTON',
    backendNodeId: 10,
    role: 'button',
    name: 'Save',
    bounds: [100, 200, 80, 40],
};

interface ActionFixtureOptions {
    hitBackendNodeId?: number;
    contains?: boolean;
    /** Simulates a navigation Chrome refused, which it reports only through errorText. */
    navigateErrorText?: string;
    /** The role and name the live element reports at action time, if it has drifted. */
    liveIdentity?: { role?: string; name?: string };
}

/** Wires the CDP calls the action path makes that the fixture does not model itself. */
function actionFixture(fixture: FixtureSession, options: ActionFixtureOptions = {}) {
    fixture.stub('DOM.scrollIntoViewIfNeeded', () => ({}));
    fixture.stub('DOM.getBoxModel', () => ({ model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }));
    fixture.stub('DOM.getNodeForLocation', () => ({ backendNodeId: options.hitBackendNodeId ?? 10 }));
    fixture.stub('DOM.describeNode', () => ({
        node: { nodeName: 'DIV', attributes: ['id', 'consent-banner', 'class', 'overlay'] },
    }));
    fixture.stub('DOM.resolveNode', () => ({ object: { objectId: 'obj-1' } }));
    fixture.stub('Runtime.callFunctionOn', () => ({ result: { value: options.contains ?? false } }));
    fixture.stub('DOM.focus', () => ({}));
    fixture.stub('Input.dispatchMouseEvent', () => ({}));
    fixture.stub('Input.dispatchKeyEvent', () => ({}));
    fixture.stub('Input.insertText', () => ({}));
    fixture.stub('Page.navigate', () => ({
        frameId: 'main-frame',
        loaderId: 'loader-1',
        ...(options.navigateErrorText ? { errorText: options.navigateErrorText } : {}),
    }));
    if (options.liveIdentity) {
        fixture.stub('Accessibility.getPartialAXTree', () => ({
            nodes: [
                {
                    nodeId: '1',
                    role: { value: options.liveIdentity?.role ?? 'button' },
                    name: { value: options.liveIdentity?.name ?? 'Save' },
                },
            ],
        }));
    }
    return fixture;
}

async function openPage(fixture: FixtureSession): Promise<BrowserPage> {
    return BrowserPage.attach(fixture.session, { budgets: FAST_BUDGETS });
}

function catchSync(fn: () => unknown): SteelToolError | undefined {
    try {
        fn();
        return undefined;
    } catch (error) {
        return error as SteelToolError;
    }
}

async function catchAsync(promise: Promise<unknown>): Promise<SteelToolError> {
    try {
        await promise;
    } catch (error) {
        return error as SteelToolError;
    }
    throw new Error('Expected the operation to fail, but it succeeded.');
}

describe('BrowserPage.navigate', () => {
    it('navigates and reports the final URL and change signal', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const outcome = await browserPage.navigate('https://example.com/');
        expect(fixture.sent.some(call => call.method === 'Page.navigate')).toBe(true);
        expect(outcome.finalUrl).toBe('https://example.com/');
        expect(outcome.change).toBeDefined();
    });

    it('reports a navigation Chrome refused instead of describing its error page as success', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            navigateErrorText: 'net::ERR_NAME_NOT_RESOLVED',
        });
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.navigate('https://nope.invalid/'));
        expect(error.message).toContain('net::ERR_NAME_NOT_RESOLVED');
        expect(error.message).toContain('https://nope.invalid/');
    });

    it('classifies a refused proxy tunnel as a proxy failure', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            navigateErrorText: 'net::ERR_TUNNEL_CONNECTION_FAILED',
        });
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.navigate('https://example.com/'));
        expect(error.code).toBe('proxy_failure');
    });

    it('restricts the settle frame filter to the main frame, so an iframe is not a page load', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const navigating = browserPage.navigate('https://example.com/');
        await new Promise(resolve => setTimeout(resolve, 0));
        fixture.emit('Page.frameStartedNavigating', {
            frameId: 'an-advert-iframe',
            url: 'https://ads.test/',
            navigationType: 'differentDocument',
        });
        const outcome = await navigating;
        expect(outcome.change.navigated, 'a subframe navigation was reported as a page load').toBe(false);
    });

    it('reports the main frame URL rather than any frame that happened to navigate', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const outcome = await browserPage.navigate('https://example.com/');
        expect(outcome.finalUrl).toBe('https://example.com/');
    });

    it('does not capture a snapshot unless one is asked for', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.navigate('https://example.com/');
        expect(fixture.sent.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);
    });
});

describe('BrowserPage.pageSummary', () => {
    it('reads only the frame and title instead of capturing a full snapshot', async () => {
        const fixture = fixtureSession(page([]));
        fixture.stub('Runtime.evaluate', () => ({ result: { value: 'Current title' } }));
        const browserPage = await openPage(fixture);

        await expect(browserPage.pageSummary()).resolves.toEqual({
            url: 'https://example.com/',
            title: 'Current title',
        });
        expect(fixture.sent.some(call => call.method === 'Accessibility.getFullAXTree')).toBe(false);
        expect(fixture.sent.some(call => call.method === 'DOMSnapshot.captureSnapshot')).toBe(false);
    });
});

describe('BrowserPage.act — click', () => {
    it('scrolls the target into view and dispatches a press and a release at its centre', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });

        expect(fixture.sent.some(call => call.method === 'DOM.scrollIntoViewIfNeeded')).toBe(true);
        const mouse = fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent');
        expect(mouse.map(call => call.params.type)).toEqual(['mousePressed', 'mouseReleased']);
        expect(mouse[0]?.params).toMatchObject({ x: 140, y: 220 });
    });

    it('uses the interpolated centre of a transformed content quad', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        fixture.stub('DOM.getBoxModel', () => ({
            model: { content: [100, 100, 200, 100, 260, 200, 100, 200] },
        }));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        await browserPage.act({ action: 'click', target: '@e1' });

        const mouse = fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent');
        expect(mouse[0]?.params).toMatchObject({ x: 165, y: 150 });
    });

    it('uses a clear inset point when another element covers the centre', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        fixture.stub('DOM.getNodeForLocation', params => ({
            backendNodeId: params.x === 140 && params.y === 220 ? 77 : 10,
        }));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        await browserPage.act({ action: 'click', target: '@e1' });

        const hitTests = fixture.sent.filter(call => call.method === 'DOM.getNodeForLocation');
        expect(hitTests[0]?.params).toMatchObject({ x: 140, y: 220 });
        const mouse = fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent');
        expect(mouse.map(call => call.params.type)).toEqual(['mousePressed', 'mouseReleased']);
        expect(mouse[0]?.params).not.toMatchObject({ x: 140, y: 220 });
        expect(Number(mouse[0]?.params.x)).toBeGreaterThan(100);
        expect(Number(mouse[0]?.params.x)).toBeLessThan(180);
        expect(Number(mouse[0]?.params.y)).toBeGreaterThan(200);
        expect(Number(mouse[0]?.params.y)).toBeLessThan(240);
        expect(mouse[1]?.params).toMatchObject({ x: mouse[0]?.params.x, y: mouse[0]?.params.y });
    });

    it('escalates a second dispatched click when neither attempt changes the page', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const first = await browserPage.act({ action: 'click', target: '@e1' });
        expect(first.change).toMatchObject({ navigated: false, domMutated: false });
        expect(first.changeDescription).toMatch(/nothing changed/i);

        const repeated = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(repeated.code).toBe('click_blocked');
        expect(repeated.message).toMatch(/twice.*nothing changed/i);
        expect(repeated.message).toMatch(/do not retry/i);
        expect(repeated.details).toMatchObject({
            reason: 'no_observed_change',
            handoff_required: true,
            diagnostic: { pointer_dispatched: true },
        });
        expect(fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent')).toHaveLength(4);
    });

    it('names the covering element when the click would not reach the target', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            hitBackendNodeId: 77,
            contains: false,
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('click_blocked');
        expect(error.message).toContain('div#consent-banner');
        const points = fixture.sent
            .filter(call => call.method === 'DOM.getNodeForLocation')
            .map(call => `${call.params.x}:${call.params.y}`);
        expect(new Set(points).size).toBeGreaterThan(1);
        expect(fixture.sent.filter(call => call.method === 'DOM.resolveNode')).toHaveLength(2);
        expect(fixture.sent.filter(call => call.method === 'DOM.describeNode')).toHaveLength(1);
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('escalates instead of encouraging a repeated blocked-click loop', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            hitBackendNodeId: 77,
            contains: false,
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        await browserPage.snapshot({});

        const repeated = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(repeated.code).toBe('click_blocked');
        expect(repeated.message).toMatch(/still blocked after a recovery attempt/i);
        expect(repeated.message).toMatch(/do not retry/i);
        expect(repeated.message).toMatch(/another candidate|session_handoff/i);
    });

    it('bounds one recovery episode across related targets covered by the same node', async () => {
        const buttons: FixtureNode[] = [
            SAVE_BUTTON,
            { ...SAVE_BUTTON, backendNodeId: 11, name: 'Save wrapper', bounds: [100, 250, 80, 40] },
            { ...SAVE_BUTTON, backendNodeId: 12, name: 'Save label', bounds: [100, 300, 80, 40] },
        ];
        const fixture = actionFixture(fixtureSession(page(buttons)), { hitBackendNodeId: 77, contains: false });
        const browserPage = await openPage(fixture);
        const snapshot = await browserPage.snapshot({});
        const refs = snapshot.nodes.filter(node => node.role === 'button').map(node => node.ref!);

        const first = await catchAsync(browserPage.act({ action: 'click', target: refs[0] }));
        const second = await catchAsync(browserPage.act({ action: 'click', target: refs[1] }));
        const third = await catchAsync(browserPage.act({ action: 'click', target: refs[2] }));

        expect(first.message).toMatch(/retry once/i);
        expect(second.message).toMatch(/retry once/i);
        expect(third.message).toMatch(/related controls.*multiple safe recovery attempts/i);
        expect(third.message).toMatch(/stop trying click variants/i);
        expect(third.details).toMatchObject({ reason: 'click_recovery_exhausted' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('preserves recovery state when a reachable retry fails during pointer dispatch', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), { contains: false });
        let hit = 77;
        fixture.stub('DOM.getNodeForLocation', () => ({ backendNodeId: hit }));
        let dispatchFails = false;
        fixture.stub('Input.dispatchMouseEvent', () => {
            if (dispatchFails) throw new Error('pointer dispatch failed');
            return {};
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        hit = 10;
        dispatchFails = true;
        await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        hit = 77;
        dispatchFails = false;

        const repeated = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(repeated.message).toMatch(/still blocked after a recovery attempt/i);
    });

    it('does not carry repeated-failure escalation into a new document that reuses the node id', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            hitBackendNodeId: 77,
            contains: false,
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));

        fixture.setPage(page([SAVE_BUTTON], { loaderId: 'loader-2' }));
        const current = await browserPage.snapshot({});
        const newRef = current.nodes.find(node => node.backendNodeId === SAVE_BUTTON.backendNodeId)?.ref;
        expect(newRef).toBeTruthy();

        const firstOnNewDocument = await catchAsync(browserPage.act({ action: 'click', target: newRef! }));
        expect(firstOnNewDocument.message).toMatch(/retry once/i);
        expect(firstOnNewDocument.message).not.toMatch(/still blocked after a recovery attempt|do not retry/i);
    });

    it('bounds retries when the same target remains hidden or collapsed', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        fixture.stub('DOM.getBoxModel', () => ({}));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const first = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(first.code).toBe('click_blocked');
        expect(first.message).toMatch(/no layout box.*retry once/i);
        await browserPage.snapshot({});

        const repeated = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(repeated.message).toMatch(/still has no clickable layout/i);
        expect(repeated.message).toMatch(/do not retry/i);
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('re-reads layout once when hit-testing finds no node on a moving page', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        let boxReads = 0;
        fixture.stub('DOM.getBoxModel', () => {
            boxReads += 1;
            return boxReads === 1
                ? { model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } }
                : { model: { content: [300, 200, 380, 200, 380, 240, 300, 240] } };
        });
        fixture.stub('DOM.getNodeForLocation', params => {
            if (Number(params.x) < 300) {
                throw new SteelToolError('DOM.getNodeForLocation failed: No node found at the given location', {
                    code: 'steel_error',
                });
            }
            return { backendNodeId: 10 };
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        await browserPage.act({ action: 'click', target: '@e1' });

        expect(boxReads).toBe(2);
        const mouse = fixture.sent.filter(call => call.method === 'Input.dispatchMouseEvent');
        expect(mouse[0]?.params).toMatchObject({ x: 340, y: 220 });
    });

    it('normalizes a persistent no-node hit test after one layout retry', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        let boxReads = 0;
        fixture.stub('DOM.getBoxModel', () => {
            boxReads += 1;
            return { model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } };
        });
        fixture.stub('DOM.getNodeForLocation', () => {
            throw new SteelToolError('DOM.getNodeForLocation failed: No node found at the given location', {
                code: 'steel_error',
            });
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));

        expect(error.code).toBe('click_blocked');
        expect(error.message).toMatch(/steel_find|steel_snapshot/);
        expect(error.message).not.toContain('DOM.getNodeForLocation');
        expect(error.details).toMatchObject({
            reason: 'no_node_at_location',
            diagnostic: { candidate_points: 5, layout_reads: 2, pointer_dispatched: false },
        });
        expect(boxReads).toBe(2);
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);

        await browserPage.snapshot({});
        const repeated = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(repeated.message).toMatch(/still unstable after a fresh recovery/i);
        expect(repeated.message).toMatch(/do not retry/i);
        expect(repeated.details).toMatchObject({ handoff_required: true });
        expect(boxReads).toBe(4);
    });

    it('never dispatches an unverified click when hit-testing returns no node id', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        fixture.stub('DOM.getNodeForLocation', () => ({}));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));

        expect(error.code).toBe('click_blocked');
        expect(error.message).toMatch(/no page node/i);
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('does not hide unrelated CDP failures or retry their layout', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        let boxReads = 0;
        fixture.stub('DOM.getBoxModel', () => {
            boxReads += 1;
            return { model: { content: [100, 200, 180, 200, 180, 240, 100, 240] } };
        });
        fixture.stub('DOM.getNodeForLocation', () => {
            throw new SteelToolError('DOM.getNodeForLocation failed: Target closed', { code: 'steel_error' });
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));

        expect(error.message).toContain('Target closed');
        expect(boxReads).toBe(1);
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('allows the click when the topmost node is a descendant of the target', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            hitBackendNodeId: 78,
            contains: true,
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    });

    it('refuses a ref from a superseded document with a precise staleness error', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        fixture.setPage(page([SAVE_BUTTON], { loaderId: 'loader-2' }));
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('stale_ref');
        expect(error.message).toMatch(/page navigated/i);
    });

    it('refuses to click a target whose role or name changed since the snapshot was read', async () => {
        // The hazard is acting on an element relabelled between the read and the click: a button
        // that said Save when the model decided, and says Delete everything by the time it lands.
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            liveIdentity: { role: 'button', name: 'Delete everything' },
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('stale_ref');
        expect(error.message).toMatch(/changed role or accessible name/i);
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('clicks when the live element still matches what the snapshot recorded', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            liveIdentity: { role: 'button', name: 'Save' },
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    });

    it('clicks when the browser cannot report a live identity, rather than refusing every action', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'click', target: '@e1' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(true);
    });

    it('refuses a click on a target that changed role, which is a different element', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])), {
            liveIdentity: { role: 'link', name: 'Save' },
        });
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('stale_ref');
    });

    it('refuses to act before any snapshot has been taken, naming the fix', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.act({ action: 'click', target: '@e1' }));
        expect(error.code).toBe('ref_not_found');
        expect(error.message).toMatch(/steel_snapshot|steel_find/);
    });
});

describe('BrowserPage.act — text entry', () => {
    const FIELD: FixtureNode = {
        tag: 'INPUT',
        backendNodeId: 20,
        role: 'textbox',
        name: 'Password',
        attributes: { type: 'password', name: 'password' },
        bounds: [0, 0, 200, 30],
    };

    it('focuses the field and inserts the text', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'type', target: '@e1', value: 'hunter2' });

        expect(fixture.sent.some(call => call.method === 'DOM.focus')).toBe(true);
        expect(fixture.sent.find(call => call.method === 'Input.insertText')?.params.text).toBe('hunter2');
    });

    it('clears the field before typing, so a value is replaced rather than appended', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'type', target: '@e1', value: 'replacement' });

        const keys = fixture.sent.filter(call => call.method === 'Input.dispatchKeyEvent');
        const selectAll = keys.find(call => JSON.stringify(call.params.commands ?? []).includes('selectAll'));
        expect(selectAll, 'nothing selected the existing content before typing').toBeDefined();

        const focusAt = fixture.sent.findIndex(call => call.method === 'DOM.focus');
        const selectAt = fixture.sent.indexOf(selectAll!);
        const insertAt = fixture.sent.findIndex(call => call.method === 'Input.insertText');
        expect(focusAt).toBeLessThan(selectAt);
        expect(selectAt).toBeLessThan(insertAt);
    });

    it('deletes the selection rather than inserting nothing when clearing a field', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({ action: 'type', target: '@e1', value: '' });

        expect(fixture.sent.some(call => call.method === 'Input.insertText')).toBe(false);
        const keys = fixture.sent.filter(call => call.method === 'Input.dispatchKeyEvent');
        expect(keys.some(call => call.params.key === 'Delete')).toBe(true);
    });

    it('never echoes a value typed into a password field back to the caller', async () => {
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        const outcome = await browserPage.act({ action: 'type', target: '@e1', value: 'hunter2' });
        expect(JSON.stringify(outcome)).not.toContain('hunter2');
    });

    it('echoes an ordinary value so the caller can see what was entered', async () => {
        const fixture = actionFixture(
            fixtureSession(
                page([
                    {
                        tag: 'INPUT',
                        backendNodeId: 23,
                        role: 'textbox',
                        name: 'City',
                        attributes: { type: 'text', name: 'city' },
                        bounds: [0, 0, 200, 30],
                    },
                ])
            )
        );
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        const outcome = await browserPage.act({ action: 'type', target: '@e1', value: 'Zagreb' });
        expect(outcome.summary).toContain('Zagreb');
    });

    it('redacts a typed value when the target came from a selector, where sensitivity is unknown', async () => {
        // The selector path has no snapshot node to consult. Unknown must mean redacted, or a
        // password typed via #password is echoed verbatim into model context and logs.
        const fixture = actionFixture(fixtureSession(page([FIELD])));
        fixture.stub('DOM.getDocument', () => ({ root: { nodeId: 1 } }));
        fixture.stub('DOM.querySelector', () => ({ nodeId: 42 }));
        fixture.stub('DOM.describeNode', () => ({ node: { backendNodeId: 999, nodeName: 'INPUT', attributes: [] } }));
        const browserPage = await openPage(fixture);

        const outcome = await browserPage.act({ action: 'type', target: '#password', value: 'hunter2' });
        expect(JSON.stringify(outcome)).not.toContain('hunter2');
        expect(outcome.summary).toMatch(/7 characters/);
    });

    it('still echoes an ordinary value when the selector resolves to a known non-sensitive field', async () => {
        const fixture = actionFixture(
            fixtureSession(
                page([
                    {
                        tag: 'INPUT',
                        backendNodeId: 24,
                        role: 'textbox',
                        name: 'City',
                        attributes: { type: 'text', name: 'city' },
                        bounds: [0, 0, 200, 30],
                    },
                ])
            )
        );
        fixture.stub('DOM.getDocument', () => ({ root: { nodeId: 1 } }));
        fixture.stub('DOM.querySelector', () => ({ nodeId: 42 }));
        fixture.stub('DOM.describeNode', () => ({ node: { backendNodeId: 24, nodeName: 'INPUT', attributes: [] } }));
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});

        const outcome = await browserPage.act({ action: 'type', target: '#city', value: 'Zagreb' });
        expect(outcome.summary).toContain('Zagreb');
    });

    it('fills several fields in one call and settles once', async () => {
        const fixture = actionFixture(
            fixtureSession(
                page([
                    { ...FIELD, backendNodeId: 21, name: 'Email', attributes: { type: 'email', name: 'email' } },
                    { ...FIELD, backendNodeId: 22, name: 'City', attributes: { type: 'text', name: 'city' } },
                ])
            )
        );
        const browserPage = await openPage(fixture);
        await browserPage.snapshot({});
        await browserPage.act({
            action: 'fill_form',
            fields: [
                { target: '@e1', value: 'a@b.test' },
                { target: '@e2', value: 'Zagreb' },
            ],
        });
        expect(fixture.sent.filter(call => call.method === 'Input.insertText')).toHaveLength(2);
        expect(fixture.sent.filter(call => call.method === 'Runtime.evaluate').length).toBeLessThanOrEqual(4);
    });
});

describe('BrowserPage.act — keyboard', () => {
    it('sends a keydown and keyup with the virtual key code for a named key', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        await browserPage.act({ action: 'press', value: 'Enter' });
        const keys = fixture.sent.filter(call => call.method === 'Input.dispatchKeyEvent');
        expect(keys.map(call => call.params.type)).toEqual(['keyDown', 'keyUp']);
        expect(keys[0]?.params).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    });

    it('rejects an unknown key name rather than sending nothing', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.act({ action: 'press', value: 'Fnord' }));
        expect(error.code).toBe('invalid_argument');
        expect(error.message).toContain('Fnord');
    });
});

describe('BrowserPage.act — unknown action', () => {
    it('rejects an action outside the enum instead of falling off the switch', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        // batch accepts a string and casts it, so the switch is the last line of defence; without a
        // default case it returns undefined and the caller throws a bare TypeError.
        const error = await catchAsync(
            browserPage.act({ action: 'teleport' as unknown as Parameters<BrowserPage['act']>[0]['action'] })
        );
        expect(error.code).toBe('invalid_argument');
        expect(error.message).toContain('teleport');
        expect(error.message, 'the error does not name the valid actions').toContain('dismiss_overlays');
    });
});

describe('BrowserPage.act — dismiss_overlays', () => {
    it('presses Escape and clicks a recognised consent control, naming what it dismissed', async () => {
        const fixture = actionFixture(
            fixtureSession(
                page([
                    {
                        tag: 'BUTTON',
                        backendNodeId: 30,
                        role: 'button',
                        name: 'Accept all cookies',
                        bounds: [10, 10, 120, 40],
                    },
                    SAVE_BUTTON,
                ])
            )
        );
        fixture.stub('DOM.getNodeForLocation', () => ({ backendNodeId: 30 }));
        const browserPage = await openPage(fixture);

        const outcome = await browserPage.act({ action: 'dismiss_overlays' });
        expect(fixture.sent.some(call => call.method === 'Input.dispatchKeyEvent')).toBe(true);
        expect(outcome.summary).toContain('Accept all cookies');
    });

    it('says so when there was nothing to dismiss', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const outcome = await browserPage.act({ action: 'dismiss_overlays' });
        expect(outcome.summary).toMatch(/no .*overlay/i);
    });
});

describe('BrowserPage.waitFor', () => {
    it('returns as soon as the awaited text appears', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        const browserPage = await openPage(fixture);
        setTimeout(() => fixture.setPage(page([{ ...SAVE_BUTTON, name: 'Order confirmed' }])), 20);
        const outcome = await browserPage.waitFor({ text: 'Order confirmed', timeoutMs: 2_000 });
        expect(outcome.satisfied).toBe(true);
    });

    it('fails with a timeout naming what it waited for', async () => {
        const fixture = actionFixture(fixtureSession(page([SAVE_BUTTON])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.waitFor({ text: 'Never appears', timeoutMs: 60 }));
        expect(error.code).toBe('timeout');
        expect(error.message).toContain('Never appears');
    });

    it('waits for a URL match', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        const browserPage = await openPage(fixture);
        setTimeout(() => fixture.setPage(page([], { url: 'https://example.com/done' })), 20);
        expect((await browserPage.waitFor({ url: '/done', timeoutMs: 2_000 })).satisfied).toBe(true);
    });

    it('rejects a wait with no condition instead of sleeping', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        const browserPage = await openPage(fixture);
        const error = await catchAsync(browserPage.waitFor({ timeoutMs: 100 }));
        expect(error.code).toBe('invalid_argument');
    });
});

describe('BrowserPage.attach', () => {
    it('enables only the CDP domains the pipeline needs', async () => {
        const fixture = actionFixture(fixtureSession(page([])));
        await openPage(fixture);
        const enabled = fixture.sent.filter(call => call.method.endsWith('.enable')).map(call => call.method);
        expect(enabled).toContain('Page.enable');
        expect(enabled).toContain('DOM.enable');
        expect(enabled).toContain('Accessibility.enable');
        expect(enabled).not.toContain('Network.enable');
    });
});

describe('settle budget wiring', () => {
    it('uses scaled budgets by default so proxied sessions are not cut short', () => {
        expect(catchSync(() => resolveSettleBudgets(2))).toBeUndefined();
        expect(resolveSettleBudgets(2).navigationMs).toBeGreaterThan(resolveSettleBudgets(1).navigationMs);
    });
});

describe('BrowserPage.act — inside a frame', () => {
    const FRAME_BUTTON: FixtureNode = {
        tag: 'BUTTON',
        backendNodeId: 110,
        role: 'button',
        name: 'Send',
        bounds: [10, 20, 80, 30],
    };
    const FRAME_FIELD: FixtureNode = {
        tag: 'INPUT',
        backendNodeId: 111,
        role: 'textbox',
        name: 'Address',
        bounds: [10, 60, 150, 20],
    };

    /** The top document's own button next to a same-origin form frame with a field and a button. */
    function framedPage(): FixturePage {
        return page([
            SAVE_BUTTON,
            {
                tag: 'IFRAME',
                backendNodeId: 20,
                role: 'Iframe',
                name: 'Form',
                bounds: [0, 300, 800, 400],
                frame: {
                    frameId: 'frame-1',
                    loaderId: 'form-loader-1',
                    root: {
                        tag: 'HTML',
                        backendNodeId: 99,
                        role: 'RootWebArea',
                        name: 'Form',
                        bounds: [0, 0, 800, 400],
                        children: [FRAME_FIELD, FRAME_BUTTON],
                    },
                },
            },
        ]);
    }

    /** Emits what Chrome sends when only the form frame navigates, as the frame's button is released. */
    function navigateFrameOnClick(fixture: FixtureSession): void {
        fixture.stub('Input.dispatchMouseEvent', params => {
            if (params.type === 'mouseReleased') {
                fixture.emit('Page.frameStartedNavigating', {
                    frameId: 'frame-1',
                    url: 'https://forms.example.com/step-2',
                    navigationType: 'differentDocument',
                });
                fixture.emit('Page.frameNavigated', {
                    frame: { id: 'frame-1', url: 'https://forms.example.com/step-2' },
                });
                fixture.emit('Page.frameStoppedLoading', { frameId: 'frame-1' });
            }
            return {};
        });
    }

    async function refOf(browserPage: BrowserPage, name: string): Promise<string> {
        const snapshot = await browserPage.snapshot({});
        const ref = snapshot.nodes.find(node => node.name === name)?.ref;
        if (!ref) throw new Error(`no ref for ${name} in:\n${snapshot.text}`);
        return ref;
    }

    it('names the covering element when a top-document overlay sits over a control inside a frame', async () => {
        // The target and the element on top of it live in different documents, so Chrome refuses
        // to pass one to a function on the other. That refusal is the answer: the overlay is in the way.
        const fixture = actionFixture(fixtureSession(framedPage()), { hitBackendNodeId: 77 });
        fixture.stub('Runtime.callFunctionOn', () => {
            throw new SteelToolError(
                'Runtime.callFunctionOn failed: Argument should belong to the same JavaScript world as target object',
                { code: 'steel_error' }
            );
        });
        const browserPage = await openPage(fixture);
        const ref = await refOf(browserPage, 'Send');

        const error = await catchAsync(browserPage.act({ action: 'click', target: ref }));
        expect(error.code).toBe('click_blocked');
        expect(error.message).toContain('div#consent-banner');
        expect(fixture.sent.some(call => call.method === 'Input.dispatchMouseEvent')).toBe(false);
    });

    it('says the frame was not observed, rather than that nothing changed, after clicking inside it', async () => {
        const fixture = actionFixture(fixtureSession(framedPage()), { hitBackendNodeId: 110 });
        const browserPage = await openPage(fixture);
        const ref = await refOf(browserPage, 'Send');

        const outcome = await browserPage.act({ action: 'click', target: ref });
        expect(outcome.changeDescription).toMatch(/frame/i);
        expect(outcome.changeDescription).not.toMatch(/wrong element/i);
        expect(outcome.changeDescription).toMatch(/fresh snapshot/i);
    });

    it('does not count a quiet click inside a frame as a click that had no effect', async () => {
        // Two quiet clicks on a page control are a dead end worth naming. Inside a frame the click
        // may well have worked out of sight, so the same two clicks must not throw.
        const fixture = actionFixture(fixtureSession(framedPage()), { hitBackendNodeId: 110 });
        const browserPage = await openPage(fixture);
        const ref = await refOf(browserPage, 'Send');

        await browserPage.act({ action: 'click', target: ref });
        const second = await browserPage.act({ action: 'click', target: ref });
        expect(second.changeDescription).toMatch(/frame/i);
    });

    it('says the same after typing into a field inside the frame', async () => {
        const fixture = actionFixture(fixtureSession(framedPage()), { hitBackendNodeId: 111 });
        const browserPage = await openPage(fixture);
        const ref = await refOf(browserPage, 'Address');

        const outcome = await browserPage.act({ action: 'type', target: ref, value: '1 High Street' });
        expect(outcome.summary).toContain('1 High Street');
        expect(outcome.changeDescription).toMatch(/frame/i);
        expect(outcome.changeDescription).not.toMatch(/wrong element/i);
    });

    it("counts a navigation of the target's own frame as a change", async () => {
        const fixture = actionFixture(fixtureSession(framedPage()), { hitBackendNodeId: 110 });
        navigateFrameOnClick(fixture);
        const browserPage = await openPage(fixture);
        const ref = await refOf(browserPage, 'Send');

        const outcome = await browserPage.act({ action: 'click', target: ref });
        expect(outcome.change.navigated).toBe(true);
        expect(outcome.change.timedOut).toBe(false);
        expect(outcome.changeDescription).toMatch(/frame/i);
        expect(outcome.changeDescription).toContain('https://forms.example.com/step-2');
        expect(outcome.changeDescription).not.toMatch(/nothing changed/i);
    });

    it('still ignores that frame navigating when the target is in the top document', async () => {
        const fixture = actionFixture(fixtureSession(framedPage()), { hitBackendNodeId: 10 });
        navigateFrameOnClick(fixture);
        const browserPage = await openPage(fixture);
        const ref = await refOf(browserPage, 'Save');

        const outcome = await browserPage.act({ action: 'click', target: ref });
        expect(outcome.change.navigated).toBe(false);
        expect(outcome.changeDescription).not.toMatch(/frame/i);
    });
});
