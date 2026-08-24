// ABOUTME: The page controller: navigation, targeting, pointer and keyboard input, overlay
// ABOUTME: dismissal and explicit waits, each returning what actually changed on the page.
import { type ChangeSignal, describeChange } from './envelope.js';
import {
    clickBlockedError,
    clickHitTestUnstableError,
    clickLayoutUnavailableError,
    clickNoObservedChangeError,
    navigationFailedError,
    SteelToolError,
} from './errors.js';
import { readMutationCount, type SettleBudgets, type SettleWatch, watchForSettle } from './settle.js';
import {
    type CaptureOptions,
    type FindQuery,
    findInSnapshot,
    type PageSnapshot,
    PageState,
    type SnapshotNode,
} from './snapshot.js';
import type { CdpSession } from './steel/cdp.js';

/**
 * The interaction verbs, mirroring the shape of Steel's own computer-action union.
 *
 * The single source of truth: `steel_act`'s enum and `steel_batch`'s step validation both build
 * from this, so a verb can never be accepted by one and unknown to the other.
 */
export const ACTIONS = [
    'click',
    'type',
    'fill_form',
    'select',
    'check',
    'hover',
    'scroll',
    'press',
    'go_back',
    'dismiss_overlays',
] as const;

export type ActionName = (typeof ACTIONS)[number];

export interface FormField {
    target: string;
    value: string;
}

export interface ActRequest {
    action: ActionName;
    /** A `@eN` ref or a CSS selector. Agents guess selectors constantly; both are accepted. */
    target?: string | undefined;
    value?: string | undefined;
    fields?: FormField[] | undefined;
}

export interface ActOutcome {
    summary: string;
    change: ChangeSignal;
    changeDescription: string;
}

export interface NavigateOutcome {
    finalUrl: string;
    title: string;
    change: ChangeSignal;
    changeDescription: string;
}

export interface WaitRequest {
    text?: string | undefined;
    selector?: string | undefined;
    url?: string | undefined;
    timeoutMs?: number | undefined;
}

export interface WaitOutcome {
    satisfied: true;
    waitedMs: number;
    condition: string;
}

export interface AttachOptions {
    budgets: SettleBudgets;
}

/** Named keys the `press` action accepts, with the virtual key codes Chrome expects. */
const NAMED_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Space: { code: 'Space', keyCode: 32, text: ' ' },
};

/** Accessible names that identify a consent or cookie overlay's dismiss control. */
const OVERLAY_DISMISS_NAMES =
    /^(accept|agree|allow|got it|ok|okay|dismiss|close|continue|i understand|no thanks|reject)\b|cookies?$/i;

const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const WAIT_POLL_INTERVAL_MS = 250;

interface TargetHandle {
    backendNodeId: number;
    loaderId: string;
    /** The frame holding the target when it came from a ref; a selector target is in the top document. */
    frameId?: string | undefined;
    /** Present when the target came from a ref; used for the redaction and identity checks. */
    node?: SnapshotNode | undefined;
    describe: string;
}

interface Point {
    x: number;
    y: number;
}

type PointHit = { kind: 'reachable' } | { kind: 'blocked'; covering: string; blockerId: number } | { kind: 'no_node' };

interface HitNodeCacheEntry {
    reachesTarget: boolean;
    covering?: string | undefined;
}

const CLICK_RECOVERY_EPISODE_LIMIT = 3;

/** Centre first, then four points inset far enough to avoid borders and resize handles. */
const CLICK_SAMPLE_POSITIONS: ReadonlyArray<readonly [number, number]> = [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
];

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isNoNodeAtLocationError(error: unknown): boolean {
    return error instanceof Error && /DOM\.getNodeForLocation failed:.*\bNo node found\b/i.test(error.message);
}

/** Interpolates inside the real content quad, so transformed elements never get a bounding-box click. */
function pointOnQuad(quad: readonly number[], horizontal: number, vertical: number): Point {
    const [x00, y00, x10, y10, x11, y11, x01, y01] = quad as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
    ];
    const topX = x00 + (x10 - x00) * horizontal;
    const topY = y00 + (y10 - y00) * horizontal;
    const bottomX = x01 + (x11 - x01) * horizontal;
    const bottomY = y01 + (y11 - y01) * horizontal;
    return {
        x: Math.round(topX + (bottomX - topX) * vertical),
        y: Math.round(topY + (bottomY - topY) * vertical),
    };
}

/** Renders a CDP node description as the compact `tag#id.class` form used in error messages. */
function describeCdpNode(node: { nodeName?: string; attributes?: string[] } | undefined): string {
    if (!node) return 'another element';
    const attributes: Record<string, string> = {};
    const list = node.attributes ?? [];
    for (let i = 0; i + 1 < list.length; i += 2) attributes[String(list[i])] = String(list[i + 1]);
    const tag = (node.nodeName ?? 'element').toLowerCase();
    const id = attributes.id ? `#${attributes.id}` : '';
    const firstClass = attributes.class?.trim().split(/\s+/)[0];
    return `${tag}${id}${id ? '' : firstClass ? `.${firstClass}` : ''}`;
}

/** Drives one attached page over CDP. Every method reports what changed, never a bare success. */
export class BrowserPage {
    private constructor(
        private readonly session: CdpSession,
        private readonly state: PageState,
        private readonly budgets: SettleBudgets
    ) {}

    /** Enables the CDP domains the pipeline needs and nothing else. */
    static async attach(session: CdpSession, options: AttachOptions): Promise<BrowserPage> {
        await Promise.all([
            session.send('Page.enable'),
            session.send('DOM.enable'),
            session.send('Accessibility.enable'),
        ]);
        const page = new BrowserPage(session, new PageState(), options.budgets);
        // Learned once, here, rather than on first settle: a round trip between an action and the
        // event subscription is long enough to miss the navigation the action caused.
        page.mainFrameId = await page.readMainFrameId();
        return page;
    }

    /** The main frame, learned on first use, so settle can ignore navigations in subframes. */
    private mainFrameId: string | undefined;

    /** Consecutive click failures for one live node, used to stop an agent retry loop. */
    private lastClickFailure: { nodeKey: string; failures: number } | undefined;

    /** Related targets covered by the same node on one document share one bounded episode. */
    private clickFailureEpisode: { loaderId: string; blockerId: number; failures: number } | undefined;

    private clickFailureLoaderId: string | undefined;

    /** The page state, exposed so a tool can resolve refs and read the last snapshot. */
    get pageState(): PageState {
        return this.state;
    }

    /**
     * Starts watching for change, and must be called before the action is dispatched.
     *
     * Both halves need to be in place first: a click handler that mutates synchronously finishes
     * before any observer installed afterwards could see it, and some navigation commands do not
     * resolve until the navigation they caused has already committed.
     */
    private async beginChange(target?: TargetHandle): Promise<SettleWatch> {
        const baselineMutations = await readMutationCount(this.session);
        return watchForSettle(this.session, {
            budgets: this.budgets,
            baselineMutations,
            // Without this the frame filter never runs and an advert iframe navigating looks
            // exactly like the page itself loading.
            mainFrameId: this.mainFrameId,
            // A form inside an iframe submits by navigating its own frame, which is the change
            // the caller is waiting for.
            targetFrameId: target !== undefined && this.inChildFrame(target) ? target.frameId : undefined,
        });
    }

    /** Whether the target's document is a child frame, whose DOM the settle pass does not observe. */
    private inChildFrame(target: TargetHandle): boolean {
        return this.mainFrameId !== undefined && target.frameId !== undefined && target.frameId !== this.mainFrameId;
    }

    private async settleNow(
        watch: SettleWatch,
        focusChanged = false,
        target?: TargetHandle
    ): Promise<{ change: ChangeSignal; description: string }> {
        const frameUnobserved = target !== undefined && this.inChildFrame(target);
        const change: ChangeSignal = {
            ...(await watch.finish()),
            focusChanged,
            ...(frameUnobserved ? { frameUnobserved } : {}),
        };
        return { change, description: describeChange(change) };
    }

    private async currentFrame(): Promise<{ id: string; url: string; loaderId: string }> {
        const tree = await this.session.send<{
            frameTree?: { frame?: { id?: string; url?: string; loaderId?: string } };
        }>('Page.getFrameTree');
        const frame = tree.frameTree?.frame;
        return { id: frame?.id ?? '', url: frame?.url ?? '', loaderId: frame?.loaderId ?? '' };
    }

    /** Reads release context without paying for a full accessibility and DOM snapshot. */
    async pageSummary(): Promise<{ url: string; title: string }> {
        const [frame, evaluated] = await Promise.all([
            this.currentFrame(),
            this.session.send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            }),
        ]);
        return { url: frame.url, title: typeof evaluated.result?.value === 'string' ? evaluated.result.value : '' };
    }

    private async readMainFrameId(): Promise<string | undefined> {
        try {
            return (await this.currentFrame()).id || undefined;
        } catch {
            // Better to settle without the frame filter than to fail attaching to the page.
            return undefined;
        }
    }

    async navigate(url: string): Promise<NavigateOutcome> {
        const beforeLoader = (await this.currentFrame()).loaderId;
        const baseline = await this.beginChange();
        const result = await this.session.send<{ errorText?: string }>('Page.navigate', { url });
        // errorText is CDP's only failure signal. The page still ends up on Chrome's error
        // document, so ignoring it reports a DNS or connection failure as a successful load.
        if (result.errorText) throw navigationFailedError(url, result.errorText);

        const { change, description } = await this.settleNow(baseline);
        const frame = await this.currentFrame();
        if (frame.loaderId && frame.loaderId !== beforeLoader) this.clearClickFailures();
        return {
            // The frame tree is authoritative for the main frame; the settle signal is a fallback.
            finalUrl: frame.url || change.navigatedToUrl || url,
            title: await this.readTitle(),
            change,
            changeDescription: description,
        };
    }

    private async readTitle(): Promise<string> {
        try {
            const result = await this.session.send<{ result?: { value?: string } }>('Runtime.evaluate', {
                expression: 'document.title',
                returnByValue: true,
            });
            return result.result?.value ?? '';
        } catch {
            return '';
        }
    }

    /**
     * Captures the viewport as a JPEG.
     *
     * JPEG rather than PNG, and quality well below default, because the bytes travel through a
     * model's context window: an exact-pixel PNG costs several times more for no decision value.
     */
    async captureScreenshot(options: { fullPage: boolean }): Promise<{ data: string }> {
        const result = await this.session.send<{ data: string }>('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 60,
            captureBeyondViewport: options.fullPage,
        });
        return { data: result.data };
    }

    async snapshot(options: CaptureOptions): Promise<PageSnapshot> {
        const snapshot = await this.state.capture(this.session, options);
        this.observeRecoveryLoader(snapshot.loaderId);
        return snapshot;
    }

    async find(query: FindQuery, options: CaptureOptions = {}): Promise<SnapshotNode[]> {
        const snapshot = this.state.lastSnapshot ?? (await this.snapshot(options));
        return findInSnapshot(snapshot.nodes, query);
    }

    /**
     * Reads the role and accessible name the element reports right now.
     *
     * One extra CDP call on the action path, and it is what makes the identity guard real: the
     * snapshot the model read is always at least one round trip old by the time a click lands.
     */
    private async liveIdentity(backendNodeId: number): Promise<{ role: string; name: string } | undefined> {
        try {
            const partial = await this.session.send<{
                nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown }; ignored?: boolean }>;
            }>('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false });
            const node = partial.nodes?.find(candidate => !candidate.ignored) ?? partial.nodes?.[0];
            if (!node) return undefined;
            return { role: String(node.role?.value ?? ''), name: String(node.name?.value ?? '') };
        } catch {
            // A browser that cannot answer this cannot be checked; the click still gets its own
            // hit test, so failing the action here would trade a real capability for a guess.
            return undefined;
        }
    }

    /** Resolves a `@eN` ref or a CSS selector to a backend node id. */
    private async resolveTarget(target: string): Promise<TargetHandle> {
        if (target.startsWith('@e')) {
            const resolved = this.state.resolveRef(target);
            const live = await this.liveIdentity(resolved.backendNodeId);
            if (live) this.state.assertIdentityUnchanged(target, live);
            const node = this.state.lastSnapshot?.nodes.find(candidate => candidate.ref === target);
            return {
                backendNodeId: resolved.backendNodeId,
                loaderId: resolved.loaderId,
                frameId: resolved.frameId,
                node,
                describe: `${target} (${resolved.role})`,
            };
        }

        const { root } = await this.session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
        const { nodeId } = await this.session.send<{ nodeId: number }>('DOM.querySelector', {
            nodeId: root.nodeId,
            selector: target,
        });
        if (!nodeId) {
            throw new SteelToolError(
                `No element matches the selector "${target}". Call steel_find to locate the element and use its @eN ref instead.`,
                { code: 'ref_not_found', details: { target } }
            );
        }
        const described = await this.session.send<{ node?: { backendNodeId?: number } }>('DOM.describeNode', {
            nodeId,
        });
        const backendNodeId = described.node?.backendNodeId;
        if (backendNodeId === undefined) {
            throw new SteelToolError(`The selector "${target}" matched a node that cannot be targeted.`, {
                code: 'ref_not_found',
            });
        }
        // Look the node up in the last snapshot so a selector target still carries its known
        // sensitivity; when it is not there, describeTyped fails safe and redacts.
        const node = this.state.lastSnapshot?.nodes.find(candidate => candidate.backendNodeId === backendNodeId);
        return { backendNodeId, loaderId: (await this.currentFrame()).loaderId, node, describe: `"${target}"` };
    }

    private requireTarget(request: ActRequest): string {
        if (!request.target) {
            throw new SteelToolError(
                `The "${request.action}" action needs a target: a @eN ref from steel_snapshot or steel_find, or a CSS selector.`,
                { code: 'invalid_argument' }
            );
        }
        return request.target;
    }

    /** Returns safe points inside the target's real content quad after scrolling it into view. */
    private async candidatePoints(backendNodeId: number): Promise<Point[] | undefined> {
        await this.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
        const box = await this.session.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', { backendNodeId });
        const quad = box.model?.content;
        if (!quad || quad.length < 8 || quad.slice(0, 8).some(coordinate => !Number.isFinite(coordinate))) {
            return undefined;
        }
        const unique = new Map<string, Point>();
        for (const [horizontal, vertical] of CLICK_SAMPLE_POSITIONS) {
            const point = pointOnQuad(quad, horizontal, vertical);
            unique.set(`${point.x}:${point.y}`, point);
        }
        return [...unique.values()];
    }

    /** Returns the centre for actions such as hover that intentionally have one pointer position. */
    private async centreOf(handle: TargetHandle): Promise<Point> {
        const point = (await this.candidatePoints(handle.backendNodeId))?.[0];
        if (!point) throw clickLayoutUnavailableError(handle.describe);
        return point;
    }

    /**
     * Confirms the pointer would actually reach the target, and names the blocker if not.
     *
     * A click that lands on a cookie banner and reports success is the single most common
     * browsing dead-end; naming the covering element turns it into a self-correctable one.
     */
    private async hitTestPoint(
        handle: TargetHandle,
        point: Point,
        cache: Map<number, HitNodeCacheEntry>
    ): Promise<PointHit> {
        let hit: { backendNodeId?: number };
        try {
            hit = await this.session.send<{ backendNodeId?: number }>('DOM.getNodeForLocation', {
                x: point.x,
                y: point.y,
                includeUserAgentShadowDOM: false,
            });
        } catch (error) {
            if (isNoNodeAtLocationError(error)) return { kind: 'no_node' };
            throw error;
        }
        const hitId = hit.backendNodeId;
        if (hitId === undefined) return { kind: 'no_node' };
        if (hitId === handle.backendNodeId) return { kind: 'reachable' };

        const cached = cache.get(hitId);
        if (cached) {
            return cached.reachesTarget
                ? { kind: 'reachable' }
                : { kind: 'blocked', covering: cached.covering ?? 'another element', blockerId: hitId };
        }

        const [target, topmost] = await Promise.all([
            this.session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
                backendNodeId: handle.backendNodeId,
            }),
            this.session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: hitId }),
        ]);

        if (target.object?.objectId && topmost.object?.objectId) {
            let containsHit = false;
            try {
                const contains = await this.session.send<{ result?: { value?: boolean } }>('Runtime.callFunctionOn', {
                    objectId: target.object.objectId,
                    functionDeclaration: 'function(other) { return this === other || this.contains(other); }',
                    arguments: [{ objectId: topmost.object.objectId }],
                    returnByValue: true,
                });
                containsHit = contains.result?.value === true;
            } catch {
                // The two nodes live in different documents — a target inside a frame under an
                // element of the page — and Chrome will not pass one to a function on the other.
                // Nothing in another document can be inside the target, so the hit is a blocker.
                containsHit = false;
            }
            if (containsHit) {
                cache.set(hitId, { reachesTarget: true });
                return { kind: 'reachable' };
            }
        }

        const described = await this.session.send<{ node?: { nodeName?: string; attributes?: string[] } }>(
            'DOM.describeNode',
            { backendNodeId: hitId }
        );
        const covering = describeCdpNode(described.node);
        cache.set(hitId, { reachesTarget: false, covering });
        return { kind: 'blocked', covering, blockerId: hitId };
    }

    private clearClickFailures(): void {
        this.lastClickFailure = undefined;
        this.clickFailureEpisode = undefined;
        this.clickFailureLoaderId = undefined;
    }

    /** Clears click recovery after a person is asked to change the page before an action is replayed. */
    resetClickRecovery(): void {
        this.clearClickFailures();
    }

    private observeRecoveryLoader(loaderId: string): void {
        if (this.clickFailureLoaderId !== undefined && loaderId !== this.clickFailureLoaderId) {
            this.clearClickFailures();
        }
    }

    /** Records one failure and reports exact-node repetition plus a shared-blocker episode bound. */
    private markClickFailure(
        handle: TargetHandle,
        blockerId?: number
    ): { repeated: boolean; episodeExhausted: boolean } {
        const nodeKey = `${handle.loaderId}:${handle.backendNodeId}`;
        this.clickFailureLoaderId = handle.loaderId;
        const failures = this.lastClickFailure?.nodeKey === nodeKey ? this.lastClickFailure.failures + 1 : 1;
        this.lastClickFailure = { nodeKey, failures };
        let episodeExhausted = false;
        if (blockerId !== undefined) {
            const episode = this.clickFailureEpisode;
            const episodeFailures =
                episode?.loaderId === handle.loaderId && episode.blockerId === blockerId ? episode.failures + 1 : 1;
            this.clickFailureEpisode = { loaderId: handle.loaderId, blockerId, failures: episodeFailures };
            episodeExhausted = episodeFailures >= CLICK_RECOVERY_EPISODE_LIMIT;
        }
        return { repeated: failures > 1, episodeExhausted };
    }

    /** Finds a verified clickable point, refreshing geometry once if the page moves under the hit test. */
    private async reachablePoint(handle: TargetHandle): Promise<Point> {
        for (let layoutAttempt = 0; layoutAttempt < 2; layoutAttempt += 1) {
            const cache = new Map<number, HitNodeCacheEntry>();
            const points = await this.candidatePoints(handle.backendNodeId);
            if (!points) {
                const failure = this.markClickFailure(handle);
                throw clickLayoutUnavailableError(handle.describe, failure.repeated);
            }
            let firstBlocker: string | undefined;
            let firstBlockerId: number | undefined;
            let sawNoNode = false;

            for (const point of points) {
                const hit = await this.hitTestPoint(handle, point, cache);
                if (hit.kind === 'reachable') {
                    return point;
                }
                if (hit.kind === 'blocked') {
                    firstBlocker ??= hit.covering;
                    firstBlockerId ??= hit.blockerId;
                } else sawNoNode = true;
            }

            if (sawNoNode && layoutAttempt === 0) continue;
            if (firstBlocker) {
                const failure = this.markClickFailure(handle, firstBlockerId);
                throw clickBlockedError(handle.describe, firstBlocker, failure.repeated, failure.episodeExhausted);
            }
        }

        const failure = this.markClickFailure(handle);
        throw clickHitTestUnstableError(handle.describe, failure.repeated);
    }

    private async clickAt(point: { x: number; y: number }): Promise<void> {
        const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 };
        await this.session.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
        await this.session.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    }

    private async pressKey(name: string): Promise<void> {
        const key = NAMED_KEYS[name];
        if (!key) {
            throw new SteelToolError(
                `"${name}" is not a key this tool can press. Supported keys: ${Object.keys(NAMED_KEYS).join(', ')}.`,
                { code: 'invalid_argument', details: { key: name } }
            );
        }
        const base = {
            key: name,
            code: key.code,
            windowsVirtualKeyCode: key.keyCode,
            nativeVirtualKeyCode: key.keyCode,
        };
        await this.session.send('Input.dispatchKeyEvent', {
            ...base,
            type: key.text ? 'keyDown' : 'rawKeyDown',
            ...(key.text ? { text: key.text } : {}),
        });
        await this.session.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    }

    /**
     * Focuses a field, replaces whatever it already holds, and types the new value.
     *
     * Selecting the existing content through the Input domain rather than assigning `.value`
     * matters twice: it works for `contenteditable` as well as inputs, and it goes through the
     * real editing pipeline, so the `input` events a controlled component listens for actually
     * fire. Assigning the property directly leaves a framework's own state stale.
     */
    private async typeInto(handle: TargetHandle, value: string): Promise<TargetHandle> {
        await this.session.send('DOM.focus', { backendNodeId: handle.backendNodeId });
        await this.session.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            commands: ['selectAll'],
        });
        await this.session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });

        if (value === '') {
            // insertText('') would leave the selection in place rather than removing it.
            await this.pressKey('Delete');
        } else {
            // insertText replaces the current selection, so this overwrites rather than appends.
            await this.session.send('Input.insertText', { text: value });
        }
        return handle;
    }

    /**
     * Describes what was typed without repeating a secret back to the caller.
     *
     * Whether a field is sensitive is decided once, in the snapshot, where the input type and
     * autocomplete attributes are available. Re-deriving it from the visible label here would
     * either over-redact every field or miss the ones whose label says nothing useful. When the
     * snapshot has nothing to say about the target, the value is redacted rather than echoed.
     */
    private describeTyped(handle: TargetHandle, value: string): string {
        // Unknown means redacted. A selector target has no snapshot node to consult, and echoing a
        // password typed through one into the response and the logs is not a recoverable mistake.
        const knownSafe = handle.node?.sensitive === false;
        const shown = knownSafe ? `"${value}"` : `${value.length} characters`;
        return `Typed ${shown} into ${handle.describe}.`;
    }

    async act(request: ActRequest): Promise<ActOutcome> {
        switch (request.action) {
            case 'click':
            case 'check': {
                const handle = await this.resolveTarget(this.requireTarget(request));
                const point = await this.reachablePoint(handle);
                const baseline = await this.beginChange(handle);
                await this.clickAt(point);
                const { change, description } = await this.settleNow(baseline, false, handle);
                if (change.navigated || change.domMutated || change.focusChanged) {
                    this.clearClickFailures();
                } else if (!change.frameUnobserved && this.markClickFailure(handle).repeated) {
                    // Inside a frame, silence is not evidence: the frame's own DOM is not observed,
                    // so a quiet click there is neither a success nor a failure to count.
                    throw clickNoObservedChangeError(handle.describe);
                }
                return { summary: `Clicked ${handle.describe}.`, change, changeDescription: description };
            }
            case 'hover': {
                const handle = await this.resolveTarget(this.requireTarget(request));
                const point = await this.centreOf(handle);
                const baseline = await this.beginChange(handle);
                await this.session.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: Math.round(point.x),
                    y: Math.round(point.y),
                });
                const { change, description } = await this.settleNow(baseline, false, handle);
                return { summary: `Hovered ${handle.describe}.`, change, changeDescription: description };
            }
            case 'type': {
                if (request.value === undefined) {
                    throw new SteelToolError('The "type" action needs a value.', { code: 'invalid_argument' });
                }
                const handle = await this.resolveTarget(this.requireTarget(request));
                const baseline = await this.beginChange(handle);
                await this.typeInto(handle, request.value);
                const { change, description } = await this.settleNow(baseline, true, handle);
                this.clearClickFailures();
                return { summary: this.describeTyped(handle, request.value), change, changeDescription: description };
            }
            case 'fill_form': {
                if (!request.fields?.length) {
                    throw new SteelToolError('The "fill_form" action needs a non-empty fields array.', {
                        code: 'invalid_argument',
                    });
                }
                // Every target is resolved before anything is typed, so a stale ref fails the whole
                // form rather than half of it, and the frame to watch is known before the first key.
                const handles: TargetHandle[] = [];
                for (const field of request.fields) handles.push(await this.resolveTarget(field.target));
                const framed = handles.find(handle => this.inChildFrame(handle));
                const baseline = await this.beginChange(framed);
                const summaries: string[] = [];
                for (const [at, field] of request.fields.entries()) {
                    const handle = handles[at]!;
                    await this.typeInto(handle, field.value);
                    summaries.push(this.describeTyped(handle, field.value));
                }
                const { change, description } = await this.settleNow(baseline, true, framed);
                this.clearClickFailures();
                return { summary: summaries.join(' '), change, changeDescription: description };
            }
            case 'select': {
                if (request.value === undefined) {
                    throw new SteelToolError('The "select" action needs the option value to choose.', {
                        code: 'invalid_argument',
                    });
                }
                const handle = await this.resolveTarget(this.requireTarget(request));
                const resolved = await this.session.send<{ object?: { objectId?: string } }>('DOM.resolveNode', {
                    backendNodeId: handle.backendNodeId,
                });
                const baseline = await this.beginChange(handle);
                await this.session.send('Runtime.callFunctionOn', {
                    objectId: resolved.object?.objectId,
                    functionDeclaration:
                        'function(value) { this.value = value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); }',
                    arguments: [{ value: request.value }],
                });
                const { change, description } = await this.settleNow(baseline, false, handle);
                this.clearClickFailures();
                return {
                    summary: `Selected "${request.value}" in ${handle.describe}.`,
                    change,
                    changeDescription: description,
                };
            }
            case 'scroll': {
                const amount = Number.parseInt(request.value ?? '600', 10);
                const baseline = await this.beginChange();
                await this.session.send('Input.dispatchMouseEvent', {
                    type: 'mouseWheel',
                    x: 10,
                    y: 10,
                    deltaX: 0,
                    deltaY: Number.isFinite(amount) ? amount : 600,
                });
                const { change, description } = await this.settleNow(baseline);
                return { summary: `Scrolled by ${amount}px.`, change, changeDescription: description };
            }
            case 'press': {
                if (!request.value) {
                    throw new SteelToolError('The "press" action needs a key name in value.', {
                        code: 'invalid_argument',
                    });
                }
                const baseline = await this.beginChange();
                await this.pressKey(request.value);
                const { change, description } = await this.settleNow(baseline);
                return { summary: `Pressed ${request.value}.`, change, changeDescription: description };
            }
            case 'go_back': {
                const history = await this.session.send<{
                    currentIndex: number;
                    entries: Array<{ id: number }>;
                }>('Page.getNavigationHistory');
                const previous = history.entries?.[history.currentIndex - 1];
                if (!previous) {
                    throw new SteelToolError('There is no previous page in this session history.', {
                        code: 'invalid_argument',
                    });
                }
                const beforeLoader = (await this.currentFrame()).loaderId;
                const baseline = await this.beginChange();
                await this.session.send('Page.navigateToHistoryEntry', { entryId: previous.id });
                const { change, description } = await this.settleNow(baseline);
                const afterLoader = (await this.currentFrame()).loaderId;
                if (afterLoader && afterLoader !== beforeLoader) this.clearClickFailures();
                return { summary: 'Went back one page.', change, changeDescription: description };
            }
            case 'dismiss_overlays':
                return this.dismissOverlays();
            default:
                // Reachable because steel_batch validates a string before casting it. Falling off
                // the switch would return undefined and surface as a bare TypeError.
                throw new SteelToolError(
                    `"${String(request.action)}" is not an action this tool performs. ` +
                        `Valid actions: ${ACTIONS.join(', ')}.`,
                    { code: 'invalid_argument', details: { action: String(request.action) } }
                );
        }
    }

    /** Presses Escape and clicks a recognised consent control, if one is on the page. */
    private async dismissOverlays(): Promise<ActOutcome> {
        const baseline = await this.beginChange();
        await this.pressKey('Escape');
        const snapshot = await this.snapshot({});
        const candidate = snapshot.nodes.find(
            node => node.ref !== undefined && node.inViewport && OVERLAY_DISMISS_NAMES.test(node.name)
        );

        if (!candidate?.ref) {
            const { change, description } = await this.settleNow(baseline);
            return {
                summary: 'Pressed Escape. Found no recognised cookie or consent overlay control to click.',
                change,
                changeDescription: description,
            };
        }

        const handle = await this.resolveTarget(candidate.ref);
        const point = await this.centreOf(handle);
        await this.clickAt(point);
        const { change, description } = await this.settleNow(baseline);
        this.clearClickFailures();
        return {
            summary: `Pressed Escape and clicked "${candidate.name}".`,
            change,
            changeDescription: description,
        };
    }

    /** Polls until an explicit condition holds. There is deliberately no network-idle wait. */
    async waitFor(request: WaitRequest): Promise<WaitOutcome> {
        const condition =
            request.text !== undefined
                ? `the text "${request.text}" to appear`
                : request.selector !== undefined
                  ? `an element matching "${request.selector}" to appear`
                  : request.url !== undefined
                    ? `the URL to contain "${request.url}"`
                    : undefined;

        if (condition === undefined) {
            throw new SteelToolError(
                'steel_wait_for needs one of text, selector or url. There is no network-idle wait: name what you are waiting for.',
                { code: 'invalid_argument' }
            );
        }

        const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            if (await this.conditionHolds(request)) {
                return { satisfied: true, waitedMs: Date.now() - startedAt, condition };
            }
            await delay(WAIT_POLL_INTERVAL_MS);
        }

        throw new SteelToolError(
            `Waited ${timeoutMs}ms for ${condition} and it did not happen. Take a snapshot to see the current page, ` +
                'or raise timeout_ms if the page is genuinely slow.',
            { code: 'timeout', details: { condition, timeoutMs } }
        );
    }

    private async conditionHolds(request: WaitRequest): Promise<boolean> {
        if (request.url !== undefined) {
            const frame = await this.currentFrame();
            return frame.url.includes(request.url);
        }
        if (request.selector !== undefined) {
            const { root } = await this.session.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
            const { nodeId } = await this.session.send<{ nodeId: number }>('DOM.querySelector', {
                nodeId: root.nodeId,
                selector: request.selector,
            });
            return Boolean(nodeId);
        }
        const snapshot = await this.snapshot({});
        const needle = (request.text ?? '').toLowerCase();
        return snapshot.nodes.some(node => node.name.toLowerCase().includes(needle));
    }
}
