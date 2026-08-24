// ABOUTME: Unit tests for the settle helper: frame-navigation detection plus DOM quiescence,
// ABOUTME: with budgets scaled by a network multiplier because Steel sessions run through proxies.
import { describe, expect, it, vi } from 'vitest';
import { readMutationCount, resolveSettleBudgets, settle, watchForSettle } from '../../src/core/settle.js';
import type { CdpEventParams, CdpSession } from '../../src/core/steel/cdp.js';

interface FakeOptions {
    mutationResult?: { navigated?: boolean; mutated: boolean };
    evaluateDelayMs?: number;
}

function fakeSession(options: FakeOptions = {}) {
    const listeners = new Map<string, Set<(params: CdpEventParams) => void>>();
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];

    const session: CdpSession = {
        async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
            sent.push({ method, params });
            if (options.evaluateDelayMs) await new Promise(r => setTimeout(r, options.evaluateDelayMs));
            if (method === 'Runtime.evaluate') {
                return { result: { value: options.mutationResult?.mutated ?? false } } as T;
            }
            return {} as T;
        },
        on(event, listener) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
        },
        async close() {},
    };

    const emit = (event: string, params: CdpEventParams) => {
        for (const listener of listeners.get(event) ?? []) listener(params);
    };
    return { session, sent, emit, listeners };
}

describe('resolveSettleBudgets', () => {
    it('scales every budget by the network multiplier', () => {
        const base = resolveSettleBudgets(1);
        const scaled = resolveSettleBudgets(3);
        expect(scaled.navigationWatchMs).toBe(base.navigationWatchMs * 3);
        expect(scaled.navigationMs).toBe(base.navigationMs * 3);
        expect(scaled.mutationQuietMs).toBe(base.mutationQuietMs * 3);
        expect(scaled.mutationMaxMs).toBe(base.mutationMaxMs * 3);
    });

    it('refuses a multiplier below one, which would be tighter than localhost', () => {
        expect(() => resolveSettleBudgets(0)).toThrow(/multiplier/i);
    });
});

describe('readMutationCount', () => {
    it('installs a persistent observer in the page and returns the running count', async () => {
        const { session, sent } = fakeSession({ mutationResult: { mutated: false } });
        await readMutationCount(session);
        const evaluate = sent.find(call => call.method === 'Runtime.evaluate');
        expect(String(evaluate?.params.expression)).toContain('__steelMutations');
        expect(String(evaluate?.params.expression)).toContain('MutationObserver');
    });

    it('reports zero rather than throwing when the page cannot be reached', async () => {
        const session: CdpSession = {
            async send() {
                throw new Error('Execution context was destroyed.');
            },
            on: () => () => {},
            async close() {},
        };
        expect(await readMutationCount(session)).toBe(0);
    });
});

describe('watchForSettle', () => {
    it('counts a navigation that started before finish was called', async () => {
        // Some CDP commands do not resolve until the navigation they caused has committed, so a
        // listener attached after the command returns never sees its own event.
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const watch = watchForSettle(session, { budgets: resolveSettleBudgets(1), mainFrameId: 'main' });

        emit('Page.frameStartedNavigating', {
            frameId: 'main',
            url: 'https://example.com/previous',
            navigationType: 'historyDifferentDocument',
        });
        emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/previous' } });

        const result = await watch.finish();
        expect(result.navigated).toBe(true);
        expect(result.navigatedToUrl).toBe('https://example.com/previous');
    });

    it('unsubscribes everything once finished', async () => {
        const { session, listeners } = fakeSession({ mutationResult: { mutated: false } });
        await watchForSettle(session, { budgets: resolveSettleBudgets(1) }).finish();
        for (const event of [
            'Page.frameStartedNavigating',
            'Page.loadEventFired',
            'Page.frameNavigated',
            'Page.frameStoppedLoading',
        ]) {
            expect(listeners.get(event)?.size ?? 0, `${event} listener leaked`).toBe(0);
        }
    });
});

describe('settle', () => {
    it('reports no navigation and no mutation when the page is already quiet', async () => {
        const { session } = fakeSession({ mutationResult: { mutated: false } });
        const result = await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(result).toMatchObject({ navigated: false, domMutated: false, timedOut: false });
    });

    it('detects a real cross-document navigation and reports the destination', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: true } });
        const pending = settle(session, { budgets: resolveSettleBudgets(1) });
        await vi.waitFor(() => expect(true).toBe(true));
        emit('Page.frameStartedNavigating', {
            frameId: 'main',
            url: 'https://example.com/next',
            navigationType: 'differentDocument',
        });
        emit('Page.loadEventFired', {});
        const result = await pending;
        expect(result.navigated).toBe(true);
        expect(result.navigatedToUrl).toBe('https://example.com/next');
    });

    it('ignores same-document navigations, which load nothing', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const pending = settle(session, { budgets: resolveSettleBudgets(1) });
        for (const navigationType of ['sameDocument', 'historySameDocument']) {
            emit('Page.frameStartedNavigating', { frameId: 'main', url: 'https://example.com/#x', navigationType });
        }
        expect((await pending).navigated).toBe(false);
    });

    it('counts a cross-document history navigation, which is what go_back usually is', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const pending = settle(session, { budgets: resolveSettleBudgets(1) });
        emit('Page.frameStartedNavigating', {
            frameId: 'main',
            url: 'https://example.com/previous',
            navigationType: 'historyDifferentDocument',
        });
        emit('Page.loadEventFired', {});
        const result = await pending;
        expect(result.navigated).toBe(true);
        expect(result.navigatedToUrl).toBe('https://example.com/previous');
    });

    it('ignores navigations in subframes so an advert iframe cannot look like a page load', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const pending = settle(session, { budgets: resolveSettleBudgets(1), mainFrameId: 'main' });
        emit('Page.frameStartedNavigating', {
            frameId: 'ad-iframe',
            url: 'https://ads.test/',
            navigationType: 'differentDocument',
        });
        expect((await pending).navigated).toBe(false);
    });

    it('finishes a back/forward-cache restore, which never fires a load event', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const started = Date.now();
        const pending = settle(session, { budgets: resolveSettleBudgets(1), mainFrameId: 'main' });
        emit('Page.frameStartedNavigating', {
            frameId: 'main',
            url: 'https://example.com/previous',
            navigationType: 'historyDifferentDocument',
        });
        emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/previous' } });
        const result = await pending;
        expect(result.navigated).toBe(true);
        expect(result.timedOut, 'the navigation wait burned its whole budget').toBe(false);
        expect(Date.now() - started).toBeLessThan(resolveSettleBudgets(1).navigationMs);
    });

    it('reports a DOM mutation without a navigation', async () => {
        const { session } = fakeSession({ mutationResult: { mutated: true } });
        const result = await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(result).toMatchObject({ navigated: false, domMutated: true });
    });

    it('counts a mutation that fired before the quiescence probe was installed', async () => {
        // A click handler that mutates synchronously finishes long before an observer installed
        // afterwards can see anything, which is why the running counter exists.
        let count = 0;
        const session: CdpSession = {
            async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
                if (method !== 'Runtime.evaluate') return {} as T;
                const expression = String(params.expression);
                if (expression.includes('__steelMutations')) return { result: { value: count } } as T;
                return { result: { value: false } } as T;
            },
            on: () => () => {},
            async close() {},
        };
        const baseline = await readMutationCount(session);
        count = 7;
        const result = await settle(session, { budgets: resolveSettleBudgets(1), baselineMutations: baseline });
        expect(result.domMutated).toBe(true);
    });

    it('does not claim a mutation when the counter did not move', async () => {
        const session: CdpSession = {
            async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
                if (method !== 'Runtime.evaluate') return {} as T;
                const expression = String(params.expression);
                if (expression.includes('__steelMutations')) return { result: { value: 3 } } as T;
                return { result: { value: false } } as T;
            },
            on: () => () => {},
            async close() {},
        };
        const result = await settle(session, { budgets: resolveSettleBudgets(1), baselineMutations: 3 });
        expect(result.domMutated).toBe(false);
    });

    it('runs the quiescence probe in the page with the configured budgets', async () => {
        const { session, sent } = fakeSession({ mutationResult: { mutated: false } });
        await settle(session, { budgets: { ...resolveSettleBudgets(1), mutationQuietMs: 150, mutationMaxMs: 2500 } });
        const evaluate = sent.find(call => call.method === 'Runtime.evaluate');
        expect(evaluate).toBeDefined();
        expect(String(evaluate?.params.expression)).toContain('MutationObserver');
        expect(String(evaluate?.params.expression)).toContain('150');
        expect(String(evaluate?.params.expression)).toContain('2500');
        expect(evaluate?.params.awaitPromise).toBe(true);
    });

    it('unsubscribes its navigation listener so repeated actions do not leak handlers', async () => {
        const { session, listeners } = fakeSession({ mutationResult: { mutated: false } });
        await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(listeners.get('Page.frameStartedNavigating')?.size ?? 0).toBe(0);
    });

    it('reports a timeout rather than hanging when the page never goes quiet', async () => {
        const { session } = fakeSession({ mutationResult: { mutated: true }, evaluateDelayMs: 60 });
        const result = await settle(session, {
            budgets: { navigationWatchMs: 5, navigationMs: 10, mutationQuietMs: 5, mutationMaxMs: 10 },
        });
        expect(result.timedOut).toBe(true);
    });

    it('does not throw when the quiescence probe fails because the page navigated away', async () => {
        const session: CdpSession = {
            async send() {
                throw new Error('Execution context was destroyed.');
            },
            on: () => () => {},
            async close() {},
        };
        const result = await settle(session, { budgets: resolveSettleBudgets(1) });
        expect(result.domMutated).toBe(true);
    });
});

describe('watchForSettle — a target inside a frame', () => {
    it("counts a navigation in the target's frame and settles when that frame stops loading", async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        // A subframe never fires the page's load event, so without the frame's own stop signal the
        // watch would wait out the whole navigation budget.
        const budgets = { ...resolveSettleBudgets(1), navigationMs: 10_000 };
        const watch = watchForSettle(session, { budgets, mainFrameId: 'main', targetFrameId: 'frame-1' });

        emit('Page.frameStartedNavigating', {
            frameId: 'frame-1',
            url: 'https://forms.example.com/step-2',
            navigationType: 'differentDocument',
        });
        emit('Page.frameNavigated', { frame: { id: 'frame-1', url: 'https://forms.example.com/step-2' } });
        emit('Page.frameStoppedLoading', { frameId: 'frame-1' });

        const started = Date.now();
        const result = await watch.finish();
        expect(result).toMatchObject({
            navigated: true,
            navigatedToUrl: 'https://forms.example.com/step-2',
            navigatedInFrame: true,
            timedOut: false,
        });
        expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('still ignores a navigation in a frame that is neither the main frame nor the target', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const watch = watchForSettle(session, {
            budgets: resolveSettleBudgets(1),
            mainFrameId: 'main',
            targetFrameId: 'frame-1',
        });
        emit('Page.frameStartedNavigating', {
            frameId: 'an-advert-iframe',
            url: 'https://ads.test/',
            navigationType: 'differentDocument',
        });
        const result = await watch.finish();
        expect(result.navigated).toBe(false);
        expect(result.navigatedInFrame).toBeFalsy();
    });

    it('does not mark a main-frame navigation as a frame one', async () => {
        const { session, emit } = fakeSession({ mutationResult: { mutated: false } });
        const watch = watchForSettle(session, {
            budgets: resolveSettleBudgets(1),
            mainFrameId: 'main',
            targetFrameId: 'frame-1',
        });
        emit('Page.frameStartedNavigating', {
            frameId: 'main',
            url: 'https://example.com/next',
            navigationType: 'differentDocument',
        });
        emit('Page.loadEventFired', {});
        const result = await watch.finish();
        expect(result.navigated).toBe(true);
        expect(result.navigatedInFrame).toBeFalsy();
    });
});
