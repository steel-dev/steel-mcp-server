// ABOUTME: Launches a local headless Chrome and drives it over CDP, exposing one session for a host
// ABOUTME: page and one for the sandboxed app frame inside it, so a test can read what the app painted.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * How much of Chrome's stderr to keep for a failure message. A browser that grumbles for the whole
 * startup timeout must not grow the heap, and only the last lines say why it stopped.
 */
const STDERR_TAIL_CHARS = 16_384;

/**
 * How long to wait for a launching Chrome to publish its debugging port.
 *
 * This is a bounded experiment after two CI runners reached the old 20s bound without publishing a
 * port. An early exit is still reported promptly; a process that remains unready may be slow or stuck,
 * and this deadline does not claim to distinguish the two.
 */
const LAUNCH_TIMEOUT_MS = 90_000;

/** Every launch stage has its own bound so Vitest reports the stage, not only that its hook expired. */
const CDP_HANDSHAKE_TIMEOUT_MS = 20_000;
const PROCESS_EXIT_TIMEOUT_MS = 5_000;

/** Browsers that can run the app, in the order they are preferred. `CHROME_PATH` wins over all. */
const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
];

/** The Chrome binary this machine has, or `null` when there is none to run. */
export function findChrome(): string | null {
    const configured = process.env.CHROME_PATH;
    if (configured !== undefined && configured !== '') return existsSync(configured) ? configured : null;
    return CHROME_CANDIDATES.find(existsSync) ?? null;
}

/**
 * Writes a skip reason to stderr.
 *
 * Vitest does not print the names of skipped suites at default verbosity, so without this a machine
 * with no Chrome looks exactly like a suite nobody wrote.
 */
export function announceMissing(suite: string, missing: readonly string[]): void {
    if (missing.length === 0) return;
    if (process.env.CI === 'true') {
        throw new Error(`${suite} requires ${missing.join(' and ')} in CI; skipping browser coverage is forbidden.`);
    }
    process.stderr.write(
        `\n  SKIPPED ${suite}: this machine has no ${missing.join(' and no ')}.\n` +
            '  Install Google Chrome (or point CHROME_PATH at a Chromium build) and re-run npm run test:browser.\n\n'
    );
}

/**
 * Polls `read` until `ok` accepts what it returns, then returns that value.
 *
 * Browser-side effects land asynchronously and at times only the renderer decides, so every wait in
 * these tests is on an observable condition rather than a sleep, and reports what it last saw when
 * it gives up.
 */
export async function until<T>(
    label: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
    timeoutMs = 10_000
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let seen = await read();
    while (!ok(seen)) {
        if (Date.now() >= deadline) {
            throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; last saw ${JSON.stringify(seen)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 50));
        seen = await read();
    }
    return seen;
}

interface CdpEvent {
    method: string;
    params: Record<string, unknown>;
    sessionId?: string;
}

/** One CDP socket, with id-matched replies and a session id on every command that needs one. */
class CdpConnection {
    private nextId = 0;
    private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
    private readonly listeners = new Set<(event: CdpEvent) => void>();

    private constructor(private readonly socket: WebSocket) {
        socket.on('message', raw => {
            const message = JSON.parse(raw.toString()) as {
                id?: number;
                result?: unknown;
                error?: { message?: string };
            } & Partial<CdpEvent>;
            if (typeof message.id === 'number') {
                const waiter = this.pending.get(message.id);
                if (!waiter) return;
                this.pending.delete(message.id);
                if (message.error) waiter.reject(new Error(`CDP refused the command: ${message.error.message}`));
                else waiter.resolve(message.result as never);
                return;
            }
            if (typeof message.method !== 'string') return;
            const event: CdpEvent = {
                method: message.method,
                params: message.params ?? {},
                sessionId: message.sessionId,
            };
            for (const listener of this.listeners) listener(event);
        });
    }

    static async open(url: string): Promise<CdpConnection> {
        const socket = new WebSocket(url, {
            perMessageDeflate: false,
            maxPayload: 256 << 20,
            handshakeTimeout: CDP_HANDSHAKE_TIMEOUT_MS,
        });
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('open', resolve);
                socket.once('error', reject);
            });
        } catch (cause) {
            socket.terminate();
            throw new Error(
                `Chrome published its debugging endpoint, but the CDP WebSocket failed to open within ${CDP_HANDSHAKE_TIMEOUT_MS}ms: ${errorMessage(cause)}`,
                { cause }
            );
        }
        return new CdpConnection(socket);
    }

    send<T = Record<string, unknown>>(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string
    ): Promise<T> {
        const id = ++this.nextId;
        this.socket.send(
            JSON.stringify(sessionId === undefined ? { id, method, params } : { id, method, params, sessionId })
        );
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: never) => void, reject });
            setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`${method} got no CDP reply within 20s`));
            }, 20_000);
        });
    }

    on(listener: (event: CdpEvent) => void): void {
        this.listeners.add(listener);
    }

    close(): void {
        this.socket.close();
    }
}

/**
 * A page holding the fake host document, plus the app frame nested inside it.
 *
 * The app runs in a `sandbox="allow-scripts"` iframe and so has an opaque origin: the host page's own
 * scripts cannot reach into it at all, which is the point. Reading the app's DOM therefore goes
 * through the app frame's own CDP session rather than through the host page.
 */
export class BrowserPage {
    /** Set when Chrome gave the app frame its own target, which it does only when it isolates it. */
    private appSession: string | null = null;
    /** The first child frame of the host document, which is the app. */
    private appFrameId: string | null = null;
    /** The default execution context of every frame reported on this page's session, by frame. */
    private readonly contextByFrame = new Map<string, number>();

    /** The app frame's context, used when the frame shares the page's process and so has no target. */
    private get appContextId(): number | null {
        if (this.appFrameId === null) return null;
        return this.contextByFrame.get(this.appFrameId) ?? null;
    }
    /** Uncaught errors the app frame reported, so a broken app cannot pass quietly. */
    readonly appExceptions: string[] = [];

    constructor(
        private readonly connection: CdpConnection,
        private readonly targetId: string,
        private readonly pageSession: string
    ) {
        connection.on(event => {
            if (event.method === 'Target.attachedToTarget' && event.sessionId === this.pageSession) {
                const info = event.params.targetInfo as { type?: string } | undefined;
                if (info?.type === 'iframe') this.appSession = event.params.sessionId as string;
                return;
            }
            if (event.method === 'Page.frameAttached' && event.sessionId === this.pageSession) {
                // The host document holds exactly one child frame, and it is the app.
                this.appFrameId ??= event.params.frameId as string;
                return;
            }
            if (event.method === 'Runtime.executionContextCreated' && event.sessionId === this.pageSession) {
                const context = event.params.context as
                    | { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
                    | undefined;
                const frameId = context?.auxData?.frameId;
                // Contexts are kept by frame rather than matched against the app frame as they
                // arrive, because the frame one belongs to may not have been announced yet.
                if (frameId !== undefined && context?.auxData?.isDefault === true && typeof context.id === 'number') {
                    this.contextByFrame.set(frameId, context.id);
                }
                return;
            }
            if (event.method === 'Runtime.executionContextDestroyed' && event.sessionId === this.pageSession) {
                const destroyed = event.params.executionContextId as number | undefined;
                for (const [frameId, contextId] of this.contextByFrame) {
                    if (contextId === destroyed) this.contextByFrame.delete(frameId);
                }
                return;
            }
            if (event.method === 'Runtime.exceptionThrown' && this.raisedByApp(event)) {
                const details = event.params.exceptionDetails as
                    | { text?: string; exception?: { description?: string } }
                    | undefined;
                this.appExceptions.push(details?.exception?.description ?? details?.text ?? 'unknown exception');
            }
        });
    }

    /** Whether an exception came from the app frame, under either way of reaching it. */
    private raisedByApp(event: CdpEvent): boolean {
        if (this.appSession !== null) return event.sessionId === this.appSession;
        if (this.appContextId === null || event.sessionId !== this.pageSession) return false;
        const details = event.params.exceptionDetails as { executionContextId?: number } | undefined;
        return details?.executionContextId === this.appContextId;
    }

    /** Loads `url` and waits until the app frame inside it has built its DOM. */
    async load(url: string): Promise<void> {
        await this.connection.send('Page.navigate', { url }, this.pageSession);
        await until(
            'the app frame to attach',
            async () => ({ session: this.appSession, context: this.appContextId }),
            found => found.session !== null || found.context !== null
        );
        if (this.appSession !== null) await this.connection.send('Runtime.enable', {}, this.appSession);
        await until(
            'the app document to build its stage',
            () => this.evalInApp<boolean>("document.getElementById('stage') !== null").catch(() => false),
            built => built
        );
    }

    /** Evaluates in the fake host page, which owns the postMessage log. */
    evalInHost<T>(expression: string): Promise<T> {
        return this.evaluate<T>(this.pageSession, expression);
    }

    /** Evaluates inside the app frame, the only way to see the DOM the app writes. */
    evalInApp<T>(expression: string): Promise<T> {
        if (this.appSession !== null) return this.evaluate<T>(this.appSession, expression);
        if (this.appContextId !== null) return this.evaluate<T>(this.pageSession, expression, this.appContextId);
        throw new Error('the app frame has not attached yet');
    }

    /** Clicks at a point in the top-level page, in its own CSS pixels. */
    async clickAt(x: number, y: number): Promise<void> {
        for (const type of ['mousePressed', 'mouseReleased']) {
            await this.connection.send(
                'Input.dispatchMouseEvent',
                { type, x, y, button: 'left', buttons: 1, clickCount: 1 },
                this.pageSession
            );
        }
    }

    /** Navigates away, which is what makes the app frame fire `pagehide` for real. */
    async navigateAway(): Promise<void> {
        await this.connection.send('Page.navigate', { url: 'about:blank' }, this.pageSession);
    }

    async close(): Promise<void> {
        await this.connection.send('Target.closeTarget', { targetId: this.targetId }).catch(() => undefined);
    }

    private async evaluate<T>(sessionId: string, expression: string, contextId?: number): Promise<T> {
        const call = { expression, returnByValue: true, awaitPromise: true };
        const reply = await this.connection.send<{
            result: { value?: unknown };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
        }>('Runtime.evaluate', contextId === undefined ? call : { ...call, contextId }, sessionId);
        if (reply.exceptionDetails) {
            const details = reply.exceptionDetails;
            throw new Error(`evaluating in the browser threw: ${details.exception?.description ?? details.text}`);
        }
        return reply.result.value as T;
    }
}

/** A headless Chrome the tests own for the whole file, one fresh page per test. */
export class HeadlessChrome {
    private jpegSession: BrowserPage | null = null;

    private constructor(
        private readonly process: ChildProcess,
        private readonly connection: CdpConnection,
        private readonly profile: string,
        /** The browser's own DevTools endpoint, for a test that wants a connection of its own. */
        readonly debuggerUrl: string
    ) {}

    static async launch(binary: string): Promise<HeadlessChrome> {
        const profile = mkdtempSync(join(tmpdir(), 'steel-viewer-chrome-'));
        const startedAt = Date.now();
        const loggingArgs = process.env.CHROME_DEBUG_LOGGING === '1' ? ['--enable-logging=stderr', '--v=1'] : [];
        const child = spawn(
            binary,
            [
                '--headless=new',
                '--remote-debugging-port=0',
                `--user-data-dir=${profile}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1000,700',
                // The fake CDP endpoint is a self-signed TLS server, because the app only ever opens
                // a `wss:` URL and its own CSP allows no other scheme.
                '--ignore-certificate-errors',
                // The app's phases are driven by a 400ms interval and two timeouts, and a renderer
                // Chrome considers hidden throttles both, which would show up as flaky phases.
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                ...loggingArgs,
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] }
        );
        // Chrome writes its startup banner and any GPU grumbling to stderr; draining keeps the pipe
        // from filling and the test output clean. The tail is kept rather than discarded, because a
        // browser that refuses to start says why here and nowhere else.
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
            stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
        });
        const stderrClosed = child.stderr
            ? new Promise<void>(resolve => {
                  if (child.stderr!.closed) resolve();
                  else child.stderr!.once('close', () => resolve());
              })
            : Promise.resolve();
        // A browser that dies on startup never writes the port file, so without this the wait runs
        // its full timeout and reports a deadline instead of the exit that caused it.
        let exited: string | undefined;
        let spawnFailure: string | undefined;
        child.on('exit', (code, signal) => {
            exited = signal === null ? `exited with code ${code}` : `was killed by ${signal}`;
        });
        child.on('error', error => {
            spawnFailure = `could not be spawned: ${error.message}`;
        });

        try {
            const endpoint = await readDebuggerUrl(profile, LAUNCH_TIMEOUT_MS, {
                ending: () => processEnding(child, spawnFailure, exited),
                status: () => describeProcess(child, spawnFailure),
                stderr: () => stderr,
            });
            const connection = await CdpConnection.open(endpoint.url);
            if (process.env.CI === 'true') {
                process.stderr.write(
                    `\n  Chrome launch: binary=${JSON.stringify(binary)}, pid=${child.pid ?? 'unassigned'}, ` +
                        `port=${endpoint.elapsedMs}ms, cdp=${Date.now() - startedAt}ms.\n`
                );
            }
            return new HeadlessChrome(child, connection, profile, endpoint.url);
        } catch (error) {
            const primary = asError(error);
            const cleanupErrors: string[] = [];
            const stderrAtFailure = stderr;
            try {
                await terminateProcess(child);
            } catch (cleanupError) {
                cleanupErrors.push(`terminating Chrome: ${errorMessage(cleanupError)}`);
            }
            await Promise.race([stderrClosed, delay(1_000)]);
            try {
                await removeOnceSettled(profile);
            } catch (cleanupError) {
                cleanupErrors.push(`removing ${profile}: ${errorMessage(cleanupError)}`);
            }
            const lateStderr = stderrSince(stderrAtFailure, stderr);
            if (lateStderr !== '') primary.message += `\nChrome stderr captured during cleanup:\n${lateStderr}`;
            if (cleanupErrors.length > 0)
                primary.message += `\nLaunch cleanup also failed: ${cleanupErrors.join('; ')}`;
            throw primary;
        }
    }

    /** Opens a fresh tab on `url` and waits for the app frame inside it. */
    async openPage(url: string): Promise<BrowserPage> {
        const { targetId } = await this.connection.send<{ targetId: string }>('Target.createTarget', {
            url: 'about:blank',
            background: false,
        });
        const { sessionId } = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId,
            flatten: true,
        });
        await this.connection.send('Page.enable', {}, sessionId);
        // Chrome reaches the sandboxed app frame in one of two ways, and which one it picks is its
        // own decision about processes rather than anything the test controls. An isolated frame
        // gets its own target, and auto-attach is how a session for it arrives. A frame sharing the
        // page's process gets no target at all, and is reachable only as an execution context on
        // this session. Both are asked for here, because a suite that needs one of them is a suite
        // that passes on one machine and times out on another.
        await this.connection.send(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            sessionId
        );
        await this.connection.send('Runtime.enable', {}, sessionId);
        const page = new BrowserPage(this.connection, targetId, sessionId);
        await page.load(url);
        return page;
    }

    /**
     * Encodes a real solid-colour JPEG and returns its base64 payload.
     *
     * The fake screencast needs bytes a JPEG decoder accepts, and the honest way to get them is to
     * let the same browser that will decode them do the encoding.
     */
    async encodeJpeg(cssColor: string, width: number, height: number): Promise<string> {
        this.jpegSession ??= await this.openBlankPage();
        return this.jpegSession.evalInHost<string>(
            `(function(){` +
                `var canvas = document.createElement('canvas');` +
                `canvas.width = ${width}; canvas.height = ${height};` +
                `var context = canvas.getContext('2d');` +
                `context.fillStyle = ${JSON.stringify(cssColor)};` +
                `context.fillRect(0, 0, ${width}, ${height});` +
                `return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];` +
                `})()`
        );
    }

    async close(): Promise<void> {
        this.connection.close();
        await terminateProcess(this.process);
        await removeOnceSettled(this.profile);
    }

    /** A tab with no app frame in it, used only as a scratch canvas for JPEG encoding. */
    private async openBlankPage(): Promise<BrowserPage> {
        const { targetId } = await this.connection.send<{ targetId: string }>('Target.createTarget', {
            url: 'about:blank',
            background: true,
        });
        const { sessionId } = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
            targetId,
            flatten: true,
        });
        return new BrowserPage(this.connection, targetId, sessionId);
    }
}

/** Sends Chrome its terminal signal and does not return until the spawned process has ended. */
export async function terminateProcess(child: ChildProcess): Promise<void> {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve, reject) => {
        const finish = (): void => {
            clearTimeout(timer);
            child.off('exit', finish);
            child.off('error', fail);
            resolve();
        };
        const fail = (error: Error): void => {
            clearTimeout(timer);
            child.off('exit', finish);
            child.off('error', fail);
            reject(error);
        };
        const timer = setTimeout(() => {
            fail(new Error(`Chrome pid ${child.pid} did not exit within ${PROCESS_EXIT_TIMEOUT_MS}ms after SIGKILL`));
        }, PROCESS_EXIT_TIMEOUT_MS);
        child.once('exit', finish);
        child.once('error', fail);
        if (child.exitCode !== null || child.signalCode !== null) finish();
        else if (!child.kill('SIGKILL')) fail(new Error(`could not send SIGKILL to Chrome pid ${child.pid}`));
    });
}

/**
 * Deletes a Chrome profile directory once Chrome has finished writing into it.
 *
 * Killing the process Node spawned does not kill the zygote and renderers it left behind, and they
 * keep writing for a few milliseconds after their parent is gone. A single delete races them and
 * fails with ENOTEMPTY, which `maxRetries` does not cover: the directory is being refilled rather
 * than locked.
 */
async function removeOnceSettled(directory: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            rmSync(directory, { recursive: true, force: true, maxRetries: 20 });
            return;
        } catch (error) {
            if (attempt >= 20) throw error;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
}

/** What a launching Chrome has said and what Node can observe about its process. */
export interface LaunchWatch {
    /** How the process ended or failed to spawn, or `undefined` when neither has been observed. */
    ending: () => string | undefined;
    /** A point-in-time process snapshot for a timeout report. */
    status: () => string;
    /** The tail of everything the process wrote to stderr. */
    stderr: () => string;
}

interface DebuggerEndpoint {
    url: string;
    elapsedMs: number;
}

type PortObservation =
    | { kind: 'ready'; url: string }
    | { kind: 'missing' }
    | { kind: 'unreadable'; error: string }
    | { kind: 'malformed'; contents: string };

/**
 * Reads the debugging endpoint Chrome writes into its profile once it is listening.
 *
 * Asking for port 0 and reading the port back is what keeps two runs on one machine from fighting
 * over a hardcoded port.
 */
export async function readDebuggerUrl(
    profile: string,
    timeoutMs: number,
    watch: LaunchWatch
): Promise<DebuggerEndpoint> {
    const file = join(profile, 'DevToolsActivePort');
    const startedAt = Date.now();
    for (;;) {
        const observation = observeDebuggerPort(file);
        const elapsedMs = Date.now() - startedAt;
        if (observation.kind === 'ready') return { url: observation.url, elapsedMs };
        const ending = watch.ending();
        if (ending !== undefined) {
            throw new Error(
                `Chrome ${ending} after ${elapsedMs}ms before it started listening. ` +
                    `${describePort(file, observation)} ${watch.status()}.${reportStderr(watch.stderr())}`
            );
        }
        if (elapsedMs >= timeoutMs) {
            throw new Error(
                `Chrome did not start listening within ${timeoutMs}ms. ${describePort(file, observation)} ` +
                    `${watch.status()}. ${describeProfile(profile)}.${reportStderr(watch.stderr())}`
            );
        }
        await delay(Math.min(50, timeoutMs - elapsedMs));
    }
}

function observeDebuggerPort(file: string): PortObservation {
    let contents: string;
    try {
        contents = readFileSync(file, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', error: errorMessage(error) };
    }
    const [portText, path] = contents.split(/\r?\n/);
    const port = Number(portText);
    if (Number.isInteger(port) && port > 0 && port <= 65_535 && path?.startsWith('/') === true) {
        return { kind: 'ready', url: `ws://127.0.0.1:${port}${path}` };
    }
    return { kind: 'malformed', contents: contents.slice(0, 256) };
}

function describePort(file: string, observation: Exclude<PortObservation, { kind: 'ready' }>): string {
    if (observation.kind === 'missing') return `${file} was absent.`;
    if (observation.kind === 'unreadable') return `${file} could not be read: ${observation.error}.`;
    return `${file} existed but was malformed: ${JSON.stringify(observation.contents)}.`;
}

function describeProcess(child: ChildProcess, spawnFailure: string | undefined): string {
    return (
        `Process status: pid=${child.pid ?? 'unassigned'}, exitCode=${String(child.exitCode)}, ` +
        `signalCode=${String(child.signalCode)}, killed=${child.killed}` +
        (spawnFailure === undefined ? '' : `, spawnError=${JSON.stringify(spawnFailure)}`)
    );
}

function processEnding(
    child: ChildProcess,
    spawnFailure: string | undefined,
    observedExit: string | undefined
): string | undefined {
    if (spawnFailure !== undefined) return spawnFailure;
    if (observedExit !== undefined) return observedExit;
    if (child.signalCode !== null) return `was killed by ${child.signalCode}`;
    if (child.exitCode !== null) return `exited with code ${child.exitCode}`;
    return undefined;
}

function describeProfile(profile: string): string {
    try {
        const entries = readdirSync(profile).sort();
        if (entries.length === 0) return 'The Chrome profile was empty';
        const shown = entries.slice(0, 20).map(name => JSON.stringify(name));
        const suffix = entries.length > shown.length ? `, and ${entries.length - shown.length} more` : '';
        return `The Chrome profile contained ${shown.join(', ')}${suffix}`;
    } catch (error) {
        return `The Chrome profile could not be inspected: ${errorMessage(error)}`;
    }
}

/** Renders what stderr had delivered by the deadline; Chrome may still have buffered other output. */
function reportStderr(stderr: string): string {
    const text = stderr.trim();
    return text === '' ? ' No Chrome stderr had been captured by the deadline.' : `\nChrome stderr:\n${text}`;
}

function stderrSince(before: string, after: string): string {
    if (after === before) return '';
    return (after.startsWith(before) ? after.slice(before.length) : after).trim();
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(errorMessage(error));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
