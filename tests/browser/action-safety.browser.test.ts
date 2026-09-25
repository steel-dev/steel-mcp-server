// ABOUTME: Real-Chrome regressions for automatic overlay dismissal and verified click targeting.
// ABOUTME: Local synthetic pages record button events so unintended actions never affect an account.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserPage } from '../../src/core/page.js';
import { CdpConnection, type CdpSession } from '../../src/core/steel/cdp.js';
import { announceMissing, findChrome, HeadlessChrome, until } from '../helpers/headless-chrome.js';

const chromePath = findChrome();
announceMissing('action safety browser suite', chromePath ? [] : ['Google Chrome']);
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

async function load(body: string): Promise<void> {
    const html = `<html><head><style>button { position:absolute; left:100px; top:100px; width:180px; height:50px } [role=dialog] { position:fixed; inset:0; } #cover { z-index:100; }</style></head><body>${body}<script>window.actions=[];for(const b of document.querySelectorAll('button')) b.onclick=()=>window.actions.push(b.id);</script></body></html>`;
    await page.navigate(`data:text/html,${encodeURIComponent(html)}`);
    await until(
        'fixture ready',
        async () =>
            (
                await session.send<{ result: { value: boolean } }>('Runtime.evaluate', {
                    expression: 'Array.isArray(window.actions)',
                    returnByValue: true,
                })
            ).result.value,
        Boolean
    );
}

async function actions(): Promise<string[]> {
    return (
        await session.send<{ result: { value: string[] } }>('Runtime.evaluate', {
            expression: 'window.actions',
            returnByValue: true,
        })
    ).result.value;
}

const CONSENT =
    '<div role="dialog" aria-label="Cookie consent"><p>Choose your cookie consent preferences.</p><button id="accept">Accept all cookies</button></div>';

describe.skipIf(!chromePath)('safe automatic dismissal', () => {
    it.each(['Continue to payment', 'Accept all cookies', 'Save'])(
        'does not click an ordinary %s control',
        async label => {
            await load(`<button id="ordinary">${label}</button>`);
            await page.act({ action: 'dismiss_overlays' });
            expect(await actions()).toEqual([]);
        }
    );

    it('dismisses a genuine consent dialog', async () => {
        await load(CONSENT);
        await page.act({ action: 'dismiss_overlays' });
        expect(await actions()).toEqual(['accept']);
    });

    it('refuses a covered consent button just like a normal click', async () => {
        await load(`${CONSENT}<button id="cover">Delete account</button>`);
        await expect(page.act({ action: 'dismiss_overlays' })).rejects.toMatchObject({ code: 'click_blocked' });
        expect(await actions()).toEqual([]);
        await expect(page.act({ action: 'click', target: '#accept' })).rejects.toMatchObject({ code: 'click_blocked' });
        expect(await actions()).toEqual([]);
    });
});

describe.skipIf(!chromePath)('verified clicks on a scrolled page', () => {
    // The document scrolls, so the target's viewport coordinates differ from its page coordinates.
    const TALL = '<div style="height:3000px"></div>';

    it('clicks a button far below the fold', async () => {
        await load(`${TALL}<button id="far" style="top:2400px">Buy pack</button>`);
        await page.act({ action: 'click', target: '#far' });
        expect(await actions()).toEqual(['far']);
    });

    it('clicks a button at the bottom of a short page that sits below other content', async () => {
        // The page cannot scroll far enough to centre the button, so it lands low in the viewport and
        // the content one scroll-distance above it sits where an unadjusted hit test looks.
        await load(
            '<div style="height:700px"></div><div id="label" style="position:absolute;left:0;top:440px;width:600px;height:80px">1,000 credits</div><button id="bottom" style="top:600px">Buy pack</button>'
        );
        await page.act({ action: 'click', target: '#bottom' });
        expect(await actions()).toEqual(['bottom']);
    });

    it('still refuses a scrolled button under a fixed backdrop', async () => {
        await load(
            `${TALL}<button id="under" style="top:2400px">Buy pack</button><div id="cover" style="position:fixed;inset:0"></div>`
        );
        await expect(page.act({ action: 'click', target: '#under' })).rejects.toMatchObject({ code: 'click_blocked' });
        expect(await actions()).toEqual([]);
    });
});
