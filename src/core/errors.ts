// ABOUTME: Turns Steel REST failures, bot-detection interstitials and CDP failures into tool-execution
// ABOUTME: errors whose text names the cause, the affected resource and exactly one next thing to try.
import type { CallToolResult } from '@modelcontextprotocol/server';

/** Stable machine-readable classification carried alongside every error message. */
export type SteelErrorCode =
    | 'payment_required'
    | 'rate_limited'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'proxy_failure'
    | 'bot_detection'
    | 'login_required'
    | 'stale_ref'
    | 'ref_not_found'
    | 'click_blocked'
    | 'client_capability_missing'
    | 'human_control_active'
    | 'self_host_unsupported'
    | 'session_expired'
    | 'session_releasing'
    | 'invalid_argument'
    | 'timeout'
    | 'steel_error';

export interface SteelToolErrorOptions {
    code: SteelErrorCode;
    /** Steel's own documentation link, relayed verbatim when the API supplies one. */
    linkToDocs?: string | undefined;
    /** Seconds the caller should wait before retrying, when the response said so. */
    retryAfterSeconds?: number | undefined;
    /** Extra fields surfaced in `structuredContent` for programmatic callers. */
    details?: Record<string, unknown> | undefined;
}

/** An error whose message is written for the model that has to recover from it. */
export class SteelToolError extends Error {
    readonly code: SteelErrorCode;
    readonly linkToDocs: string | undefined;
    readonly retryAfterSeconds: number | undefined;
    readonly details: Record<string, unknown> | undefined;

    constructor(message: string, options: SteelToolErrorOptions) {
        super(message);
        this.name = 'SteelToolError';
        this.code = options.code;
        this.linkToDocs = options.linkToDocs;
        this.retryAfterSeconds = options.retryAfterSeconds;
        this.details = options.details;
    }
}

/** The Steel API's standardised error body. */
export interface SteelErrorBody {
    message?: string;
    error?: string;
    linkToDocs?: string;
}

/** Which part of the surface produced the failure, so rate limits can be named precisely. */
export type SteelOperation = 'session_create' | 'session_release' | 'browser_tool' | 'navigate' | 'cdp' | 'account';

export interface MapErrorContext {
    operation: SteelOperation;
    retryAfterSeconds?: number | undefined;
}

const BROWSER_TOOL_LIMIT_TEXT =
    'Steel enforces two separate limits: 20 requests/min Browser Tools (scrape, screenshot, pdf) and 60 requests/min overall on Launch.';

const CONCURRENCY_LIMIT_TEXT =
    'You are at the concurrent session cap for this plan (10 on Launch, 100 on Scale). Release a session with steel_session_release before creating another.';

const ACCOUNT_LIMIT_TEXT =
    'The Steel account API is rate limited; this is separate from Browser Tools and session concurrency.';

function rateLimitMessage(body: SteelErrorBody, context: MapErrorContext): string {
    const saysConcurrency = /concurren|session limit/i.test(body.message ?? '');
    const base =
        context.operation === 'account'
            ? ACCOUNT_LIMIT_TEXT
            : saysConcurrency || context.operation === 'session_create'
              ? CONCURRENCY_LIMIT_TEXT
              : BROWSER_TOOL_LIMIT_TEXT;
    const retry =
        context.retryAfterSeconds === undefined
            ? 'Retry after a short pause.'
            : `Retry after ${context.retryAfterSeconds}s.`;
    return `Steel rate limit hit. ${base} ${retry}`;
}

/** Maps a Steel HTTP failure to an error whose prose the calling model can act on. */
export function mapSteelHttpError(status: number, body: SteelErrorBody, context: MapErrorContext): SteelToolError {
    const linkToDocs = body.linkToDocs;
    const steelMessage = body.message ?? body.error ?? `Steel returned HTTP ${status}.`;
    const opts = { linkToDocs, details: { status, operation: context.operation } };

    switch (status) {
        case 401:
        case 403:
            // Steel's own 401 body still claims Bearer is unsupported. It is supported; relaying
            // that sentence sends agents down a wrong path, so the body text is dropped here.
            return new SteelToolError(
                'Steel rejected the credential. Check that STEEL_API_KEY is set to a valid key for this ' +
                    'project and that STEEL_BASE_URL points at the right deployment.',
                { ...opts, code: status === 401 ? 'unauthorized' : 'forbidden' }
            );
        case 402:
            return new SteelToolError(
                'Steel-managed proxies and CAPTCHA solving require a $10 verified paid balance on Launch — ' +
                    'free credits do not count. Retry with use_proxy omitted, or supply your own proxy URL.',
                { ...opts, code: 'payment_required' }
            );
        case 404:
            return new SteelToolError(steelMessage, { ...opts, code: 'not_found' });
        case 407:
            return new SteelToolError(
                `Proxy authentication failed: ${steelMessage}. Check the proxy credentials, or retry without a proxy.`,
                { ...opts, code: 'proxy_failure' }
            );
        case 429:
            return new SteelToolError(rateLimitMessage(body, context), {
                ...opts,
                code: 'rate_limited',
                retryAfterSeconds: context.retryAfterSeconds,
            });
        default:
            return new SteelToolError(steelMessage, { ...opts, code: 'steel_error' });
    }
}

/** Evidence available when deciding whether a response is an anti-bot interstitial. */
export interface BlockEvidence {
    status: number;
    headers?: Record<string, string> | undefined;
    body?: string | undefined;
    finalUrl?: string | undefined;
}

/** A recognised anti-bot vendor and the specific marker that identified it. */
export interface BotBlock {
    vendor: string;
    marker: string;
}

const VENDOR_MARKERS: ReadonlyArray<{ vendor: string; marker: string; test: RegExp }> = [
    { vendor: 'Cloudflare', marker: 'cf-chl', test: /cf-chl|cf[-_]mitigated|__cf_bm|just a moment/i },
    { vendor: 'DataDome', marker: 'datadome', test: /datadome/i },
    { vendor: 'PerimeterX', marker: '_px', test: /perimeterx|_pxAppId|\b_px[A-Za-z]*=/i },
    { vendor: 'Akamai', marker: 'ak_bmsc', test: /ak_bmsc|akamai bot manager|_abck/i },
    { vendor: 'Google', marker: '/sorry/', test: /\/sorry\/|chal_t=/i },
];

/** Recognises an anti-bot interstitial from status, headers, body markers or the final URL. */
export function detectBotBlock(evidence: BlockEvidence): BotBlock | null {
    const haystack = [
        JSON.stringify(evidence.headers ?? {}),
        evidence.body?.slice(0, 4096) ?? '',
        evidence.finalUrl ?? '',
    ].join('\n');
    for (const candidate of VENDOR_MARKERS) {
        if (candidate.test.test(haystack)) return { vendor: candidate.vendor, marker: candidate.marker };
    }
    return null;
}

/** What the session already has enabled, so the ladder can name the next rung and only that one. */
export interface MitigationState {
    profileId?: string | undefined;
    paced?: boolean | undefined;
    useProxy?: boolean | undefined;
    solveCaptcha?: boolean | undefined;
    managedCredentials?: boolean | undefined;
    persistProfile?: boolean | undefined;
}

export type MitigationRung = 'identity' | 'pacing' | 'proxies' | 'captcha' | 'stealth';

export interface MitigationStep {
    rung: MitigationRung;
    advice: string;
}

const RUNG_ADVICE: Record<MitigationRung, string> = {
    identity:
        'Load an existing browser identity: create the session with profile_id to reuse stored cookies and fingerprint.',
    pacing: 'Slow down: fewer requests per minute and one session at a time before adding any new capability.',
    proxies: 'Route through a residential proxy: create the session with use_proxy: true.',
    captcha: 'Let Steel solve the challenge: create the session with solve_captcha: true.',
    stealth: 'Tune the session fingerprint (device and viewport) to match the audience the site expects.',
};

/** Returns the single next rung on the mitigation ladder given what is already in use. */
export function nextMitigationRung(state: MitigationState): MitigationStep {
    const rung: MitigationRung = !state.profileId
        ? 'identity'
        : !state.paced
          ? 'pacing'
          : !state.useProxy
            ? 'proxies'
            : !state.solveCaptcha
              ? 'captcha'
              : 'stealth';
    return { rung, advice: RUNG_ADVICE[rung] };
}

/** Builds the bot-detection error, naming the vendor and exactly one rung to try next. */
export function botDetectionError(block: BotBlock, url: string, state: MitigationState): SteelToolError {
    const step = nextMitigationRung(state);
    return new SteelToolError(
        `${url} answered with a ${block.vendor} anti-bot challenge (marker: ${block.marker}). ` +
            `This is bot detection, not a bug in the page or the tool. Next step (${step.rung}): ${step.advice} ` +
            'Change one thing at a time — stacking proxies, CAPTCHA solving and fingerprint changes at once makes the block harder to diagnose and costs more.',
        { code: 'bot_detection', details: { vendor: block.vendor, marker: block.marker, url, rung: step.rung } }
    );
}

/** What a live page revealed about being blocked, read from its snapshot rather than its headers. */
export interface PageBlockEvidence {
    /** The URL the page settled on, after redirects. */
    finalUrl: string;
    title?: string | undefined;
    /** The rendered accessibility text. Already invisible-stripped and password-redacted. */
    text?: string | undefined;
    /** True when the page holds a field the snapshot classified as sensitive, such as a password. */
    hasPasswordField?: boolean | undefined;
}

/** A block nobody but a person can clear: a challenge to solve, or a credential to enter. */
export type InteractiveBlockKind = 'captcha' | 'login_wall';

export interface InteractiveBlock {
    kind: InteractiveBlockKind;
    /** The vendor or mechanism recognised, always from this table and never from the page text. */
    vendor: string;
    marker: string;
}

/**
 * CAPTCHA widgets a person can clear in a live browser.
 *
 * Kept apart from `VENDOR_MARKERS` because these are only ever matched against rendered page text,
 * where a widget label is strong evidence. Matching them against a scrape response body would call
 * every contact form with a reCAPTCHA box a blocked page.
 */
const CAPTCHA_WIDGET_MARKERS: ReadonlyArray<{ vendor: string; marker: string; test: RegExp }> = [
    { vendor: 'reCAPTCHA', marker: 'recaptcha', test: /recaptcha|i'?m not a robot/i },
    { vendor: 'hCaptcha', marker: 'hcaptcha', test: /hcaptcha/i },
    { vendor: 'Cloudflare Turnstile', marker: 'turnstile', test: /turnstile/i },
    {
        vendor: 'human-verification',
        marker: 'human_check',
        test: /verify (that )?you('re| are) (a )?human|are you a robot/i,
    },
];

/** Words that confirm a page holding a password field is asking for one, not offering a reset. */
const LOGIN_TEXT = /\b(log ?in|sign ?in|password|passphrase|authenticate)\b/i;

/**
 * Recognises a page only a person can get past.
 *
 * The anti-bot verdict comes from `detectBotBlock`, so there is one vendor taxonomy rather than
 * two: a challenge page is the subset of anti-bot responses a person can clear by hand.
 */
export function detectInteractiveBlock(evidence: PageBlockEvidence): InteractiveBlock | null {
    const haystack = [evidence.title ?? '', evidence.text ?? ''].join('\n');

    const vendorBlock = detectBotBlock({ status: 200, body: haystack, finalUrl: evidence.finalUrl });
    if (vendorBlock) return { kind: 'captcha', vendor: vendorBlock.vendor, marker: vendorBlock.marker };

    const widget = CAPTCHA_WIDGET_MARKERS.find(candidate => candidate.test.test(haystack));
    if (widget) return { kind: 'captcha', vendor: widget.vendor, marker: widget.marker };

    // The password field is required, not merely corroborating: nearly every page carries a "Sign
    // in" link, and treating those as login walls would hand a human the browser on every hop. The
    // cost is that a wall offering only "Continue with Google" has no field and is not recognised.
    if (evidence.hasPasswordField && LOGIN_TEXT.test(haystack)) {
        return { kind: 'login_wall', vendor: 'credentials', marker: 'password_field' };
    }
    return null;
}

/** A control the page renders, as the snapshot pipeline classified it. */
export interface PageControl {
    role: string;
    name: string;
    /** True when the snapshot classified this control as a credential field, such as a password. */
    sensitive: boolean;
    /** True when the control is rendered inside the viewport. */
    visible: boolean;
    /** True when the control also takes pointer input — the snapshot gave it a `@eN` ref. */
    interactable: boolean;
}

/** Page evidence plus the controls on it, which is the part of a page its prose cannot fake. */
export interface HandoffBlockEvidence extends PageBlockEvidence {
    controls: readonly PageControl[];
}

/**
 * Roles a challenge widget wears in the accessibility tree.
 *
 * Deliberately narrow: a heading, a paragraph or a text run that names a vendor is prose, and prose
 * is what a hostile or merely chatty page controls. Turnstile, hCaptcha and reCAPTCHA all render an
 * iframe; the classic checkbox and the press-and-hold button are the other two shapes.
 */
const CHALLENGE_CONTROL_ROLES = new Set(['iframe', 'Iframe', 'checkbox', 'button', 'switch']);

/** What a challenge widget a person can operate is called, matched against control names only. */
const CHALLENGE_CONTROL_NAME =
    /captcha|turnstile|challenge|not a robot|are you a robot|verify|human|press (and hold|&)/i;

/** What the control that submits a credential form is called. */
const LOGIN_SUBMIT_NAME = /log ?in|sign ?in|continue|next|submit|authenticate|unlock/i;

/**
 * How much else a page may hold before a block on it is read as furniture rather than a wall.
 *
 * A page only a person can get past has nothing else on it: a challenge interstitial is a widget
 * and a sentence, and a login wall is a form. A reCAPTCHA v3 badge sits in the footer of a large
 * share of the working web, and a shop page that merely carries one is a page, not a block.
 *
 * Erring high here costs an unrecognised wall, which degrades to the actionable error the caller
 * used to get. Erring low costs a person being handed a drivable browser for a page that works.
 */
const MAX_INTERSTITIAL_CONTROLS = 12;
const MAX_INTERSTITIAL_TEXT = 3_000;

/** True when the page is the block and nothing else, judged on structure rather than wording. */
function isInterstitial(evidence: HandoffBlockEvidence): boolean {
    const operable = evidence.controls.filter(control => control.interactable).length;
    return operable <= MAX_INTERSTITIAL_CONTROLS && (evidence.text?.length ?? 0) <= MAX_INTERSTITIAL_TEXT;
}

/**
 * True when a person standing in this page would have something to operate.
 *
 * A challenge needs its widget rendered. Visibility rather than a ref is the bar there because the
 * widget is a cross-origin iframe, which takes no pointer events of its own — the person clicks
 * inside it. A login wall needs a credential field that is genuinely visible and takes input, plus
 * the button that submits it: a caption reading "Sign in" beside a lone password box is the cheapest
 * thing a hostile page can draw, and it submits nothing. Only a button counts as that submit, since
 * "Continue" and "Next" are ordinary words for a link to wear anywhere on the web.
 */
function hasClearableControl(kind: InteractiveBlockKind, controls: readonly PageControl[]): boolean {
    if (kind === 'captcha') {
        return controls.some(
            control =>
                control.visible &&
                CHALLENGE_CONTROL_ROLES.has(control.role) &&
                CHALLENGE_CONTROL_NAME.test(control.name)
        );
    }
    return (
        controls.some(control => control.interactable && control.sensitive) &&
        controls.some(
            control => control.interactable && control.role === 'button' && LOGIN_SUBMIT_NAME.test(control.name)
        )
    );
}

/** A recognised block, and whether the evidence supports asking a person to clear it. */
export interface BlockVerdict {
    block: InteractiveBlock;
    /**
     * True when the page is an interstitial and holds the control a person would have to operate.
     *
     * Only this may open a live browser to a person. It is a higher bar than the block itself on
     * purpose: the player URL is an unauthenticated capability to watch and drive a possibly
     * signed-in browser, so page prose must never be the whole reason one is handed out.
     */
    clearableByPerson: boolean;
}

/**
 * Decides what a live page is, and whether a person could get past it.
 *
 * `null` means the page works: either nothing matched, or a marker matched prose on a page that is
 * plainly not a wall, such as a footer badge or an article about anti-bot vendors. A verdict with
 * `clearableByPerson: false` is a real block with nothing for a person to do — a blank interstitial
 * whose answer is the mitigation ladder, not a human.
 */
export function assessInteractiveBlock(evidence: HandoffBlockEvidence): BlockVerdict | null {
    const block = detectInteractiveBlock(evidence);
    if (block === null || !isInterstitial(evidence)) return null;
    return { block, clearableByPerson: hasClearableControl(block.kind, evidence.controls) };
}

/** Builds the error for a login wall: name the identity options, never ask for a typed secret. */
export function loginWallError(url: string, state: MitigationState): SteelToolError {
    const advice = state.profileId
        ? 'This session loaded a saved browser profile, but that identity is not signed in here. Sign in through ' +
          'the live session for this run; this server does not write new login cookies back to the saved profile.'
        : 'Create the session with profile_id to reuse an identity that is already signed in, or with namespace ' +
          'to inject managed credentials. Never put a password in a tool argument.';
    return new SteelToolError(
        `${url} is asking for credentials before it will show anything. Nothing on this page can be read or ` +
            `acted on until someone signs in. ${advice}`,
        { code: 'login_required', details: { url } }
    );
}

/** The single tool-execution error for an interactive block, and the fallback when a client cannot elicit. */
export function interactiveBlockError(block: InteractiveBlock, url: string, state: MitigationState): SteelToolError {
    return block.kind === 'login_wall'
        ? loginWallError(url, state)
        : botDetectionError({ vendor: block.vendor, marker: block.marker }, url, state);
}

export interface BatchBoundaryContext {
    completedSteps: number;
    nextStep: number | null;
    remainingSteps: number;
    clearableByPerson: boolean;
}

/** Stops a batch after a detected boundary without replaying already completed mutations. */
export function batchInteractiveBlockError(
    block: InteractiveBlock,
    url: string,
    state: MitigationState,
    context: BatchBoundaryContext
): SteelToolError {
    const base = interactiveBlockError(block, url, state);
    const accounting =
        `${context.completedSteps} step(s) completed; ${context.remainingSteps} step(s) remain. ` +
        'Do not rerun completed steps.';
    const next = context.nextStep === null ? 'No batch step remains.' : `Resume at step ${context.nextStep}.`;
    const guidance = context.clearableByPerson
        ? 'Call steel_session_handoff with this same session_id, then submit only the unrun steps in a new batch.'
        : 'Follow the mitigation advice above, then submit only the unrun steps; human handoff is not offered for this block.';
    return new SteelToolError(`${base.message} ${accounting} ${next} ${guidance}`, {
        code: base.code,
        details: {
            ...base.details,
            completed_steps: context.completedSteps,
            next_step: context.nextStep,
            remaining_steps: context.remainingSteps,
            ...(context.clearableByPerson ? { handoff_required: true } : {}),
        },
    });
}

/** CDP error texts that mean the proxy, not the site, refused the connection. */
const PROXY_ERROR_TEXTS = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY|ERR_NO_SUPPORTED_PROXIES/i;

const NAVIGATION_ADVICE: ReadonlyArray<{ test: RegExp; advice: string }> = [
    { test: /ERR_NAME_NOT_RESOLVED/i, advice: 'The hostname does not resolve. Check the spelling of the URL.' },
    {
        test: /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED/i,
        advice: 'Nothing accepted the connection. The host may be down, or the port may be wrong.',
    },
    {
        test: /ERR_CERT|ERR_SSL/i,
        advice: 'The site presented a certificate the browser rejected. Check the URL uses the right scheme and host.',
    },
    {
        test: /ERR_ABORTED/i,
        advice:
            'The navigation was cancelled — usually because the URL started a download, or another navigation ' +
            'replaced it. Nothing was loaded.',
    },
    {
        test: /ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_RESPONSE/i,
        advice: 'The browser blocked the load. An ad blocker or a response header may be refusing it.',
    },
];

/**
 * Builds the error for a navigation Chrome refused.
 *
 * `errorText` on the `Page.navigate` result is the only signal CDP gives: the page still ends up
 * on Chrome's own error document, so ignoring it makes a DNS failure look like a successful load.
 */
export function navigationFailedError(url: string, errorText: string): SteelToolError {
    const advice = NAVIGATION_ADVICE.find(candidate => candidate.test.test(errorText))?.advice ?? '';
    const proxy = PROXY_ERROR_TEXTS.test(errorText);
    return new SteelToolError(
        `The browser could not load ${url}: ${errorText}.` +
            (proxy
                ? ' The proxy refused the connection. Check the proxy credentials, or create the session without use_proxy.'
                : advice
                  ? ` ${advice}`
                  : ' The page is showing the browser error document, not the site.'),
        { code: proxy ? 'proxy_failure' : 'steel_error', details: { url, errorText } }
    );
}

/** Why a `@eN` reference no longer resolves. */
export type StaleRefReason =
    | 'page_navigated'
    | 'frame_navigated'
    | 'node_removed'
    | 'role_or_name_changed'
    | 'snapshot_superseded';

const STALE_REASON_TEXT: Record<StaleRefReason, string> = {
    page_navigated: 'the page navigated to a new document',
    frame_navigated: 'the frame holding it loaded a new document',
    node_removed: 'the node was removed from the DOM',
    role_or_name_changed: 'the element changed role or accessible name',
    snapshot_superseded: 'the snapshot it came from has been superseded',
};

export interface StaleRefContext {
    refSnapshotId: string;
    currentSnapshotId: string;
    reason: StaleRefReason;
}

/** Builds the precise staleness error: which ref, from which snapshot, why, and how to recover. */
export function staleRefError(ref: string, context: StaleRefContext): SteelToolError {
    return new SteelToolError(
        `${ref} belongs to snapshot ${context.refSnapshotId} but ${STALE_REASON_TEXT[context.reason]}; ` +
            `the current snapshot is ${context.currentSnapshotId}. Call steel_find to relocate just this element, ` +
            'or steel_snapshot for the whole page, then retry with the new ref.',
        { code: 'stale_ref', details: { ref, ...context } }
    );
}

/** Builds the blocked-click error naming the element that intercepted the pointer. */
export function clickBlockedError(
    ref: string,
    coveringDescription: string,
    repeated = false,
    episodeExhausted = false
): SteelToolError {
    const recovery = episodeExhausted
        ? 'Related controls are still blocked after multiple safe recovery attempts. Stop trying click variants; ' +
          'change path, try another candidate, or call steel_session_handoff for manual control.'
        : repeated
          ? 'This control is still blocked after a recovery attempt. Do not retry it again; change strategy, ' +
            'try another candidate, or call steel_session_handoff for manual control.'
          : 'Run steel_act with action "dismiss_overlays", or scroll the target into a clear area, then use ' +
            'steel_find or steel_snapshot to reacquire it and retry once. If it is still blocked, change strategy ' +
            'or call steel_session_handoff instead of repeating the same loop.';
    return new SteelToolError(
        `Click on ${ref} did not reach the element: ${coveringDescription} is on top of it at that point. ${recovery}`,
        {
            code: 'click_blocked',
            details: {
                ref,
                covering: coveringDescription,
                ...(episodeExhausted ? { reason: 'click_recovery_exhausted' } : {}),
                ...(repeated || episodeExhausted ? { handoff_required: true } : {}),
            },
        }
    );
}

/** Builds the safe fallback when a moving page yields no hit-testable node after one layout refresh. */
export function clickHitTestUnstableError(ref: string, repeated = false): SteelToolError {
    const recovery = repeated
        ? 'Hit-testing this control is still unstable after a fresh recovery. Do not retry it again; change ' +
          'strategy, try another candidate, or call steel_session_handoff for manual control.'
        : 'Use steel_find or steel_snapshot to relocate it, then retry once. If that also fails, change strategy ' +
          'or call steel_session_handoff instead of repeating the same loop.';
    return new SteelToolError(
        `Could not safely click ${ref}: Chrome found no page node at any point inside it after re-reading its ` +
            `layout. The control may be moving or outside the viewport. ${recovery}`,
        {
            code: 'click_blocked',
            details: {
                ref,
                reason: 'no_node_at_location',
                diagnostic: { candidate_points: 5, layout_reads: 2, pointer_dispatched: false },
                ...(repeated ? { handoff_required: true } : {}),
            },
        }
    );
}

/** Builds the hidden/collapsed-target error, with stronger guidance after the same node fails twice. */
export function clickLayoutUnavailableError(ref: string, repeated = false): SteelToolError {
    const recovery = repeated
        ? 'This control still has no clickable layout after a recovery attempt. Do not retry it again; change ' +
          'strategy, try another candidate, or call steel_session_handoff for manual control.'
        : 'It may be hidden or collapsed. Use steel_find or steel_snapshot to relocate it and retry once. If it ' +
          'still has no layout, change strategy or call steel_session_handoff instead of repeating the same loop.';
    return new SteelToolError(`Could not safely click ${ref}: the target has no layout box. ${recovery}`, {
        code: 'click_blocked',
        details: { ref, reason: 'no_layout_box', ...(repeated ? { handoff_required: true } : {}) },
    });
}

/** Builds the terminal error after Chrome dispatched the same click twice without observable progress. */
export function clickNoObservedChangeError(ref: string): SteelToolError {
    return new SteelToolError(
        `Chrome dispatched a click on ${ref} twice, but nothing changed on either attempt: no page change or focus move. ` +
            'Do not retry this control again; change strategy, try another candidate, or call ' +
            'steel_session_handoff for manual control.',
        {
            code: 'click_blocked',
            details: {
                ref,
                reason: 'no_observed_change',
                handoff_required: true,
                diagnostic: { pointer_dispatched: true },
            },
        }
    );
}

/** Capabilities the self-hosted steel-browser image does not have. */
export type SelfHostCapability = 'concurrency' | 'use_proxy' | 'solve_captcha' | 'profile_id' | 'credentials' | 'files';

const SELF_HOST_TEXT: Record<SelfHostCapability, string> = {
    concurrency:
        'Self-hosted Steel runs one browser session at a time. Call steel_session_release on the existing session before creating another.',
    use_proxy:
        'Steel-managed proxies are a cloud capability; the self-hosted image has none. Remove use_proxy, or point STEEL_BASE_URL at Steel Cloud.',
    solve_captcha:
        'CAPTCHA solving is a cloud capability; the self-hosted image cannot solve challenges. Remove solve_captcha, or drive the challenge manually through the session viewer.',
    profile_id:
        'Browser profiles are a cloud capability; the self-hosted image has no profile store. Remove profile_id.',
    credentials:
        'Managed credentials are a cloud capability; the self-hosted image has no credential store. Remove namespace.',
    files: 'Session file storage is a cloud capability; the self-hosted image does not persist session files.',
};

/** Builds the named capability error for a self-hosted deployment, never an opaque 400. */
export function selfHostUnsupportedError(capability: SelfHostCapability): SteelToolError {
    return new SteelToolError(SELF_HOST_TEXT[capability], {
        code: 'self_host_unsupported',
        details: { capability },
    });
}

function describeUnknown(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : JSON.stringify(error);
}

/** Renders any throwable as an MCP tool-execution error result, never as a protocol error. */
export function toolErrorResult(error: unknown): CallToolResult {
    const steelError = error instanceof SteelToolError ? error : null;
    const message = steelError?.message ?? describeUnknown(error);
    const code: SteelErrorCode = steelError?.code ?? 'steel_error';

    const lines = [`### Error`, message];
    if (steelError?.retryAfterSeconds !== undefined) lines.push(`Retry-After: ${steelError.retryAfterSeconds}s`);
    if (steelError?.linkToDocs) lines.push(`Docs: ${steelError.linkToDocs}`);

    return {
        isError: true,
        content: [{ type: 'text', text: lines.join('\n\n') }],
        structuredContent: {
            error: {
                code,
                message,
                ...(steelError?.linkToDocs ? { linkToDocs: steelError.linkToDocs } : {}),
                ...(steelError?.retryAfterSeconds !== undefined
                    ? { retryAfterSeconds: steelError.retryAfterSeconds }
                    : {}),
                ...(steelError?.details ? { details: steelError.details } : {}),
            },
        },
    };
}
