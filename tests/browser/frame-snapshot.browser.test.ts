// ABOUTME: Reads a page whose form lives two iframes down in a real headless Chrome, so the frame
// ABOUTME: descent and the page-coordinate maths are executed against the browser, not against a fake.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PageState, type SnapshotNode } from '../../src/core/snapshot.js';
import { CdpConnection, type CdpSession } from '../../src/core/steel/cdp.js';
import { announceMissing, findChrome, readDebuggerUrl, terminateProcess, until } from '../helpers/headless-chrome.js';

const chromePath = findChrome();
const available = chromePath !== null;
announceMissing('the frame snapshot browser suite', available ? [] : ['Google Chrome']);

/** The launch, the CDP handshake and the first navigation all live inside this one hook. */
const BROWSER_SETUP_TIMEOUT_MS = 150_000;

/** The form control the test looks for, three documents down from the page the caller navigated to. */
const FIELD_LABEL = 'Address';

let server: Server | undefined;
let chrome: { close: () => Promise<void> } | undefined;
let connection: CdpConnection | undefined;
let session: CdpSession | undefined;
let origin = '';

beforeAll(async () => {
    if (!available) return;
    server = await startFixtureServer();
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const launched = await launchChrome(chromePath!);
    chrome = launched;
    connection = await CdpConnection.connect(launched.debuggerUrl);
    session = await connection.attachToPage();
    await session.send('Page.enable');
    await session.send('Page.navigate', { url: `${origin}/service` });
    // The innermost frame is written by script, so a load event on the top document proves nothing.
    await until(
        'the form frame to build its fields',
        () => countFrames(session!),
        documents => documents >= 3,
        30_000
    );
    // Every frame carries a border and padding, and the innermost one is scrolled, so the placement
    // maths is checked against Chrome with all three terms non-zero.
    await session.send('Runtime.evaluate', {
        expression:
            '(function scrollAll(w) { w.scrollTo(0, 60);' +
            " for (const f of w.document.querySelectorAll('iframe')) { try { scrollAll(f.contentWindow); } catch {} } })(window)",
    });
    await until(
        'the inner frame to report its scroll position',
        () => innerScrollTop(session!),
        scrolled => scrolled > 0,
        10_000
    );
}, BROWSER_SETUP_TIMEOUT_MS);

afterAll(async () => {
    if (connection !== undefined) await connection.close();
    if (chrome !== undefined) await chrome.close();
    if (server !== undefined) await new Promise<void>(resolve => server!.close(() => resolve()));
});

describe.skipIf(!available)('PageState.capture in a real browser', () => {
    it('gives a ref to a field two frames below the page that was navigated to', async () => {
        const snapshot = await new PageState().capture(session!, {});
        const field = fieldIn(snapshot.nodes);
        expect(field?.ref, `the snapshot was:\n${snapshot.text}`).toBeDefined();
    });

    it('puts that field where Chrome says it is on the page', async () => {
        const snapshot = await new PageState().capture(session!, {});
        const field = fieldIn(snapshot.nodes);
        expect(field?.center, `the snapshot was:\n${snapshot.text}`).toBeDefined();

        const box = await session!.send<{ model?: { content?: number[] } }>('DOM.getBoxModel', {
            backendNodeId: field!.backendNodeId,
        });
        const quad = box.model?.content ?? [];
        // The box model answers in the top frame's viewport coordinates and the snapshot in the
        // page's, so the comparison adds back how far the top page has scrolled.
        const metrics = await session!.send<{ cssLayoutViewport?: { pageX?: number; pageY?: number } }>(
            'Page.getLayoutMetrics'
        );
        const scrolled = metrics.cssLayoutViewport ?? {};
        expect(scrolled.pageY ?? 0, 'the top page has to be scrolled for this to prove anything').toBeGreaterThan(0);
        const centre = {
            x: (Math.min(quad[0]!, quad[4]!) + Math.max(quad[0]!, quad[4]!)) / 2 + (scrolled.pageX ?? 0),
            y: (Math.min(quad[1]!, quad[5]!) + Math.max(quad[1]!, quad[5]!)) / 2 + (scrolled.pageY ?? 0),
        };
        expect(field?.center?.x).toBeCloseTo(centre.x, 1);
        expect(field?.center?.y).toBeCloseTo(centre.y, 1);
    });

    it('still reads the top document', async () => {
        const snapshot = await new PageState().capture(session!, {});
        expect(snapshot.nodes.some(node => node.name === 'Start a service request')).toBe(true);
    });
});

/** The form's text input, told apart from the label that shares its accessible name. */
function fieldIn(nodes: SnapshotNode[]): SnapshotNode | undefined {
    return nodes.find(node => node.role === 'textbox' && node.name === FIELD_LABEL);
}

/** How far the innermost frame has scrolled, read through the DOM snapshot the pipeline also reads. */
async function innerScrollTop(active: CdpSession): Promise<number> {
    const snapshot = await active.send<{ documents?: Array<{ scrollOffsetY?: number }> }>(
        'DOMSnapshot.captureSnapshot',
        { computedStyles: [] }
    );
    return snapshot.documents?.at(-1)?.scrollOffsetY ?? 0;
}

async function countFrames(active: CdpSession): Promise<number> {
    const snapshot = await active.send<{ documents?: unknown[] }>('DOMSnapshot.captureSnapshot', {
        computedStyles: [],
    });
    return snapshot.documents?.length ?? 0;
}

/**
 * Serves the shape a hosted form engine uses: a service page holding a same-origin renderer frame,
 * which writes a second frame of its own from script so its URL is never in any served HTML.
 */
function startFixtureServer(): Promise<Server> {
    const pages: Record<string, string> = {
        '/service': `<!doctype html><title>Service</title><h1>Start a service request</h1>
<iframe id="renderer" src="/renderer" width="800" height="600" style="border-width: 3px; padding: 7px"></iframe>
<div style="height: 1600px">Footer guidance, so the top page can scroll too.</div>`,
        '/renderer': `<!doctype html><title>Renderer</title><div id="mount"></div>
<script>
  const frame = document.createElement('iframe');
  frame.src = '/render?form=1';
  frame.width = 760;
  frame.height = 300;
  frame.style.borderWidth = '5px';
  frame.style.padding = '11px';
  document.getElementById('mount').appendChild(frame);
</script>`,
        '/render': `<!doctype html><title>Render</title><h2>Service request</h2>
<div style="height: 220px">Guidance text that pushes the field below the fold of its own frame.</div>
<form>
  <label for="addr">${FIELD_LABEL}</label><input id="addr" name="addr" type="text">
  <button id="send" type="button">Send request</button>
</form>
<div style="height: 900px">More guidance.</div>`,
    };

    const created = createServer((request, response) => {
        const body = pages[(request.url ?? '').split('?')[0]!];
        if (body === undefined) {
            response.writeHead(404);
            response.end('no such page');
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(body);
    });
    return new Promise(resolve => created.listen(0, '127.0.0.1', () => resolve(created)));
}

async function launchChrome(binary: string): Promise<{ debuggerUrl: string; close: () => Promise<void> }> {
    const profile = mkdtempSync(join(tmpdir(), 'steel-frames-chrome-'));
    const child = spawn(
        binary,
        [
            '--headless=new',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1280,900',
            'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-8192);
    });

    const endpoint = await readDebuggerUrl(profile, 90_000, {
        ending: () => (child.exitCode === null ? undefined : `exited with code ${child.exitCode}`),
        status: () => `pid=${child.pid ?? 'unassigned'}`,
        stderr: () => stderr,
    });
    return {
        debuggerUrl: endpoint.url,
        close: async () => {
            await terminateProcess(child);
            rmSync(profile, { recursive: true, force: true, maxRetries: 20 });
        },
    };
}
