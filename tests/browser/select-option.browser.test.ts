// ABOUTME: Real-Chrome regressions for the select action: it must choose an option that exists and
// ABOUTME: refuse one that does not, instead of clearing the control and reporting success.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPage } from '../../src/core/page.js';
import { CdpConnection, type CdpSession } from '../../src/core/steel/cdp.js';
import { announceMissing, findChrome, HeadlessChrome } from '../helpers/headless-chrome.js';

const chromePath = findChrome();
announceMissing('select option browser suite', chromePath ? [] : ['Google Chrome']);
let chrome: HeadlessChrome | undefined;
let connection: CdpConnection | undefined;
let session: CdpSession;
let page: BrowserPage;

beforeAll(async () => {
    if (!chromePath) return;
    chrome = await HeadlessChrome.launch(chromePath);
    connection = await CdpConnection.connect(chrome.debuggerUrl);
    session = await connection.attachToPage();
    page = await BrowserPage.attach(session, {
        budgets: { navigationWatchMs: 5, navigationMs: 100, mutationQuietMs: 5, mutationMaxMs: 100 },
    });
}, 150_000);

afterAll(async () => {
    await connection?.close();
    await chrome?.close();
});

const FORM =
    '<select id="size"><option value="s">Small</option><option value="m" selected>Medium</option><option value="l">Large</option></select>' +
    '<script>window.changes=[];document.getElementById("size").onchange=e=>window.changes.push(e.target.value);</script>';

async function load(): Promise<void> {
    await page.navigate(`data:text/html,${encodeURIComponent(`<html><body>${FORM}</body></html>`)}`);
}

async function evaluate<T>(expression: string): Promise<T> {
    const result = await session.send<{ result: { value: T } }>('Runtime.evaluate', {
        expression,
        returnByValue: true,
    });
    return result.result.value;
}

describe.skipIf(!chromePath)('select action', () => {
    it('chooses an option by its value', async () => {
        await load();
        await page.act({ action: 'select', target: '#size', value: 'l' });
        expect(await evaluate('document.getElementById("size").value')).toBe('l');
        expect(await evaluate('window.changes')).toEqual(['l']);
    });

    it('chooses an option by its visible label', async () => {
        await load();
        await page.act({ action: 'select', target: '#size', value: 'Small' });
        expect(await evaluate('document.getElementById("size").value')).toBe('s');
    });

    it('refuses an option that does not exist and leaves the selection alone', async () => {
        await load();
        await expect(page.act({ action: 'select', target: '#size', value: 'XXL' })).rejects.toMatchObject({
            code: 'invalid_argument',
            message: expect.stringContaining('"XXL"'),
        });
        expect(await evaluate('document.getElementById("size").value')).toBe('m');
        expect(await evaluate('window.changes')).toEqual([]);
    });
});
