// ABOUTME: Waits for a page to settle after an action: a short frame-navigation watch, then the
// ABOUTME: navigation itself, then DOM quiescence measured by an in-page MutationObserver.
import type { CdpEventParams, CdpSession } from './steel/cdp.js';

/** Time budgets for one settle pass, already scaled by the network multiplier. */
export interface SettleBudgets {
    /** How long to watch for a navigation to start before concluding none will. */
    navigationWatchMs: number;
    /** How long to wait for a started navigation to finish loading. */
    navigationMs: number;
    /** Quiet period with no DOM mutations that counts as settled. */
    mutationQuietMs: number;
    /** Hard cap on the quiescence wait, however busy the page is. */
    mutationMaxMs: number;
}

/** What the settle pass observed. This is the change signal every action tool returns. */
export interface SettleResult {
    navigated: boolean;
    navigatedToUrl: string | undefined;
    /** True when the navigation happened in the target's frame rather than in the page itself. */
    navigatedInFrame?: boolean | undefined;
    domMutated: boolean;
    /** True when a budget expired before the page went quiet. */
    timedOut: boolean;
}

export interface SettleOptions {
    budgets: SettleBudgets;
    /** When given, navigations in other frames are ignored so an iframe cannot look like a load. */
    mainFrameId?: string | undefined;
    /**
     * The frame holding the action's target, when that is not the main frame.
     *
     * A form inside an iframe submits by navigating its own frame, so that navigation counts as a
     * change too. A subframe never fires the page's load event, so the pass completes when the
     * frame reports that it stopped loading.
     */
    targetFrameId?: string | undefined;
    /**
     * The mutation counter read before the action, from {@link readMutationCount}.
     *
     * A click handler that mutates the DOM synchronously has finished long before an observer
     * installed afterwards could see it, so the quiescence probe alone reports "nothing changed"
     * on a click that plainly worked. The running counter closes that window.
     */
    baselineMutations?: number | undefined;
}

const BASE_BUDGETS: SettleBudgets = {
    navigationWatchMs: 100,
    navigationMs: 3_000,
    mutationQuietMs: 100,
    mutationMaxMs: 3_000,
};

/**
 * Navigation kinds that do not load a new document and must not count as a navigation.
 *
 * `historyDifferentDocument` is deliberately absent: it does load a different document, which is
 * what a cross-document back or forward is, and the caller needs to wait for that load.
 */
const NON_LOADING_NAVIGATION_TYPES = new Set(['sameDocument', 'historySameDocument']);

/** Cross-document back and forward, which can be served from the back/forward cache. */
function isHistoryNavigation(navigationType: string): boolean {
    return navigationType === 'historyDifferentDocument';
}

/**
 * Scales the base budgets by a network multiplier.
 *
 * Steel sessions reach the internet through Steel's fleet and often a proxy, so they are
 * systematically slower than the localhost browser these constants were tuned against.
 */
export function resolveSettleBudgets(multiplier: number): SettleBudgets {
    if (!Number.isFinite(multiplier) || multiplier < 1) {
        throw new Error(`Settle multiplier must be at least 1, got ${multiplier}.`);
    }
    return {
        navigationWatchMs: BASE_BUDGETS.navigationWatchMs * multiplier,
        navigationMs: BASE_BUDGETS.navigationMs * multiplier,
        mutationQuietMs: BASE_BUDGETS.mutationQuietMs * multiplier,
        mutationMaxMs: BASE_BUDGETS.mutationMaxMs * multiplier,
    };
}

/**
 * Installs a page-lifetime mutation counter if one is not already there, and returns its value.
 *
 * The counter is stored on `window`, so a document load resets it to zero — which is correct:
 * a navigation is itself a change, and the caller already treats it as one.
 */
export async function readMutationCount(session: CdpSession): Promise<number> {
    const expression = `(() => {
    const state = window.__steelMutations || (window.__steelMutations = { count: 0 });
    if (!state.observer) {
        state.observer = new MutationObserver(records => { state.count += records.length; });
        state.observer.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, characterData: true,
        });
    }
    return state.count;
})()`;
    try {
        const result = await session.send<{ result?: { value?: number } }>('Runtime.evaluate', {
            expression,
            returnByValue: true,
        });
        return result.result?.value ?? 0;
    } catch {
        // No reachable execution context yet; the caller only needs a baseline it can compare.
        return 0;
    }
}

function quiescenceExpression(quietMs: number, maxMs: number): string {
    return `new Promise(resolve => {
    const target = document.body || document.documentElement;
    if (!target) { resolve(false); return; }
    let mutated = false;
    let quietTimer;
    const finish = () => { observer.disconnect(); clearTimeout(quietTimer); clearTimeout(capTimer); resolve(mutated); };
    const observer = new MutationObserver(() => {
        mutated = true;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, ${quietMs});
    });
    observer.observe(target, { childList: true, subtree: true, attributes: true });
    quietTimer = setTimeout(finish, ${quietMs});
    const capTimer = setTimeout(finish, ${maxMs});
})`;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<{ value: T; timedOut: boolean }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), ms);
    });
    try {
        const outcome = await Promise.race([work, timeout]);
        return outcome === 'timeout' ? { value: onTimeout, timedOut: true } : { value: outcome as T, timedOut: false };
    } finally {
        clearTimeout(timer);
    }
}

/** A settle pass that has already subscribed, so no event between now and `finish` is lost. */
export interface SettleWatch {
    finish(): Promise<SettleResult>;
}

/**
 * Subscribes to the navigation events and returns a handle that finishes the settle pass.
 *
 * Subscribing has to happen before the action is dispatched. Some CDP commands —
 * `Page.navigateToHistoryEntry` among them — do not resolve until the navigation has already
 * committed, so a listener attached after the command returns never sees the event that command
 * caused, and the action reports that nothing happened.
 */
export function watchForSettle(session: CdpSession, options: SettleOptions): SettleWatch {
    const { budgets, mainFrameId, targetFrameId } = options;
    let navigatedToUrl: string | undefined;
    let navigatedFrameId: string | undefined;
    let navigationType = '';
    let loadObserved = false;
    let commitObserved = false;
    let frameStoppedLoading = false;
    let onComplete: (() => void) | undefined;
    const completion = new Promise<void>(resolve => {
        onComplete = resolve;
    });

    /** Whether a frame's navigation counts: the page's own, or the frame the target sits in. */
    const watched = (frameId: unknown): boolean =>
        !mainFrameId || frameId === mainFrameId || (targetFrameId !== undefined && frameId === targetFrameId);
    const settled = () =>
        loadObserved || frameStoppedLoading || (commitObserved && isHistoryNavigation(navigationType));

    const offStarted = session.on('Page.frameStartedNavigating', (params: CdpEventParams) => {
        const type = String(params.navigationType ?? '');
        if (NON_LOADING_NAVIGATION_TYPES.has(type)) return;
        if (!watched(params.frameId)) return;
        if (navigatedToUrl !== undefined) return;
        navigatedToUrl = typeof params.url === 'string' ? params.url : undefined;
        navigatedFrameId = typeof params.frameId === 'string' ? params.frameId : undefined;
        navigationType = type;
        if (settled()) onComplete?.();
    });

    const offLoad = session.on('Page.loadEventFired', () => {
        loadObserved = true;
        onComplete?.();
    });

    const offNavigated = session.on('Page.frameNavigated', (params: CdpEventParams) => {
        const frame = params.frame as { id?: string } | undefined;
        if (!watched(frame?.id)) return;
        commitObserved = true;
        // A back/forward-cache restore commits without ever firing a load event, so a history
        // navigation would otherwise burn the whole budget on every cross-document go_back.
        if (isHistoryNavigation(navigationType)) onComplete?.();
    });

    const offStopped = session.on('Page.frameStoppedLoading', (params: CdpEventParams) => {
        if (navigatedFrameId === undefined || params.frameId !== navigatedFrameId) return;
        frameStoppedLoading = true;
        onComplete?.();
    });

    return {
        async finish(): Promise<SettleResult> {
            let timedOut = false;
            try {
                await delay(budgets.navigationWatchMs);
                if (navigatedToUrl !== undefined && !settled()) {
                    const outcome = await withDeadline(completion, budgets.navigationMs, undefined);
                    timedOut ||= outcome.timedOut;
                }
            } finally {
                offStarted();
                offLoad();
                offNavigated();
                offStopped();
            }

            let domMutated: boolean;
            try {
                const probe = session.send<{ result?: { value?: boolean } }>('Runtime.evaluate', {
                    expression: quiescenceExpression(budgets.mutationQuietMs, budgets.mutationMaxMs),
                    awaitPromise: true,
                    returnByValue: true,
                });
                const outcome = await withDeadline(probe, budgets.mutationMaxMs + budgets.mutationQuietMs, undefined);
                timedOut ||= outcome.timedOut;
                const observedDuringProbe = outcome.value?.result?.value ?? navigatedToUrl !== undefined;
                const counted =
                    options.baselineMutations === undefined
                        ? false
                        : (await readMutationCount(session)) !== options.baselineMutations;
                domMutated = observedDuringProbe || counted;
            } catch {
                // The execution context is destroyed by a navigation mid-probe. That is itself
                // proof the DOM changed, so report a mutation rather than failing the action.
                domMutated = true;
            }

            const navigatedInFrame =
                navigatedToUrl !== undefined &&
                targetFrameId !== undefined &&
                navigatedFrameId === targetFrameId &&
                navigatedFrameId !== mainFrameId;
            return {
                navigated: navigatedToUrl !== undefined,
                navigatedToUrl,
                ...(navigatedInFrame ? { navigatedInFrame } : {}),
                domMutated,
                timedOut,
            };
        },
    };
}

/**
 * Subscribes and finishes in one call, for a caller with nothing to dispatch in between.
 *
 * The change signal matters as much as the wait: an action that produced no navigation, no
 * mutation and no focus change must be reported as such, because a tool that always says
 * "success" makes a model conclude the application is broken when input is silently dropped.
 */
export async function settle(session: CdpSession, options: SettleOptions): Promise<SettleResult> {
    return watchForSettle(session, options).finish();
}
