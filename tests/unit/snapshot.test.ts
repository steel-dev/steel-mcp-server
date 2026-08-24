// ABOUTME: Unit tests for the accessibility snapshot pipeline: which nodes earn a @eN ref, how refs
// ABOUTME: survive DOM mutation, viewport marking, password redaction and precise staleness errors.
import { describe, expect, it } from 'vitest';
import type { SteelToolError } from '../../src/core/errors.js';
import { findInSnapshot, identityChanged, PageState, renderSnapshot } from '../../src/core/snapshot.js';
import { type FixtureFrame, type FixtureNode, type FixturePage, fixtureSession } from '../helpers/cdp-fixture.js';

function page(children: FixtureNode[], overrides: Partial<FixturePage> = {}): FixturePage {
    return {
        root: {
            tag: 'HTML',
            backendNodeId: 1,
            role: 'RootWebArea',
            name: overrides.title ?? 'Example',
            bounds: [0, 0, 1280, 720],
            children,
        },
        url: 'https://example.com/',
        title: 'Example',
        loaderId: 'loader-1',
        ...overrides,
    };
}

const BUTTON: FixtureNode = {
    tag: 'BUTTON',
    backendNodeId: 10,
    role: 'button',
    name: 'Save',
    bounds: [10, 20, 80, 30],
};

/** The form engine's own document, the shape a hosted form renders in. */
function formFrame(children: FixtureNode[], overrides: Partial<FixtureFrame> = {}): FixtureFrame {
    return {
        frameId: 'frame-1',
        url: 'https://forms.example.com/render',
        root: {
            tag: 'HTML',
            backendNodeId: 99,
            role: 'RootWebArea',
            name: 'Fill form',
            bounds: [0, 0, 800, 600],
            children,
        },
        ...overrides,
    };
}

/** Sits at (30, 40) with a 2px border and 4px padding, so its document starts at (36, 46). */
function iframe(frame: FixtureFrame, overrides: Partial<FixtureNode> = {}): FixtureNode {
    return {
        tag: 'IFRAME',
        backendNodeId: 20,
        role: 'Iframe',
        name: 'Report a problem',
        bounds: [30, 40, 800, 600],
        computed: {
            'border-left-width': '2px',
            'border-top-width': '2px',
            'border-right-width': '2px',
            'border-bottom-width': '2px',
            'padding-left': '4px',
            'padding-top': '4px',
            'padding-right': '4px',
            'padding-bottom': '4px',
        },
        frame,
        ...overrides,
    };
}

const FRAME_FIELD: FixtureNode = {
    tag: 'INPUT',
    backendNodeId: 100,
    role: 'textbox',
    name: 'Address',
    bounds: [10, 20, 150, 20],
};

describe('PageState.capture — which nodes earn a ref', () => {
    it('gives a ref to a visible node that receives pointer events', async () => {
        const { session } = fixtureSession(page([BUTTON]));
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button?.ref).toBe('@e1');
    });

    it('withholds a ref from a node with pointer-events none, but keeps it in the text', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, pointerEvents: 'none' }]));
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button).toBeDefined();
        expect(button?.ref).toBeUndefined();
    });

    it('withholds a ref from a visibility-hidden node', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, visibility: 'hidden' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.ref).toBeUndefined();
    });

    it('withholds a ref from a node the layout engine never rendered', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, bounds: undefined }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.ref).toBeUndefined();
    });

    it('withholds a ref from a zero-area node', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, bounds: [10, 20, 0, 0] }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.ref).toBeUndefined();
    });

    it('drops accessibility-ignored nodes entirely', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, ignored: true }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')).toBeUndefined();
    });

    it('keeps an off-screen node with a ref and marks it out of the viewport', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, bounds: [10, 3000, 80, 30] }]));
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button?.ref).toBe('@e1');
        expect(button?.inViewport).toBe(false);
    });
});

describe('PageState.capture — ref stability', () => {
    it('keeps a ref across a DOM mutation that changes the accessible name', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        const first = await state.capture(fixture.session, {});
        const originalRef = first.nodes.find(node => node.role === 'button')?.ref;

        fixture.setPage(page([{ ...BUTTON, name: 'Saving…' }]));
        const second = await state.capture(fixture.session, {});

        expect(second.nodes.find(node => node.role === 'button')?.ref).toBe(originalRef);
        expect(second.snapshotId).not.toBe(first.snapshotId);
    });

    it('issues fresh refs after a document load so an old ref can never silently resolve', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});

        fixture.setPage(page([BUTTON], { loaderId: 'loader-2', url: 'https://example.com/2' }));
        const second = await state.capture(fixture.session, {});

        expect(second.loaderId).toBe('loader-2');
        expect(second.nodes.find(node => node.role === 'button')?.ref).not.toBe('@e1');
    });

    it('assigns a new ref to a node that appears after the first snapshot', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});

        fixture.setPage(
            page([BUTTON, { tag: 'A', backendNodeId: 11, role: 'link', name: 'Next', bounds: [10, 60, 40, 20] }])
        );
        const second = await state.capture(fixture.session, {});
        expect(second.nodes.find(node => node.role === 'link')?.ref).toBe('@e2');
    });
});

describe('PageState.capture — tree noise', () => {
    it('never gives the document root a ref, however focusable Chrome says it is', async () => {
        const { session } = fixtureSession(page([BUTTON]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'RootWebArea')?.ref).toBeUndefined();
    });

    it('drops InlineTextBox nodes, which duplicate their StaticText parent', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'P',
                    backendNodeId: 50,
                    role: 'StaticText',
                    name: 'Hello world',
                    bounds: [0, 0, 100, 20],
                    children: [{ tag: '#text', backendNodeId: 51, role: 'InlineTextBox', name: 'Hello world' }],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.some(node => node.role === 'InlineTextBox')).toBe(false);
        expect(snapshot.text).toContain('Hello world');
        expect(snapshot.text.match(/Hello world/g) ?? []).toHaveLength(1);
    });

    it('collapses a StaticText child that only repeats its parent name', async () => {
        const { session } = fixtureSession(
            page([
                {
                    ...BUTTON,
                    children: [{ tag: '#text', backendNodeId: 52, role: 'StaticText', name: 'Save' }],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text.match(/"Save"/g) ?? []).toHaveLength(1);
    });

    it('omits properties whose value is false, including the string "false"', async () => {
        const { session } = fixtureSession(
            page([{ ...BUTTON, properties: { invalid: 'false', disabled: false, level: 2 } }])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text).not.toContain('invalid');
        expect(snapshot.text).not.toContain('disabled');
        expect(snapshot.text).toContain('[level=2]');
    });
});

describe('PageState.capture — frames', () => {
    it('gives a ref to a control inside a child frame', async () => {
        const { session } = fixtureSession(page([iframe(formFrame([FRAME_FIELD]))]));
        const snapshot = await new PageState().capture(session, {});
        const field = snapshot.nodes.find(node => node.name === 'Address');
        expect(field?.ref, 'a control inside an iframe must be targetable').toBeDefined();
    });

    it('nests a frame under the iframe element that holds it', async () => {
        const { session } = fixtureSession(page([iframe(formFrame([FRAME_FIELD]))]));
        const snapshot = await new PageState().capture(session, {});
        const holder = snapshot.nodes.find(node => node.role === 'Iframe');
        const field = snapshot.nodes.find(node => node.name === 'Address');
        expect(holder).toBeDefined();
        expect(field?.depth, 'the frame content sits below the iframe').toBeGreaterThan(holder?.depth ?? 0);
    });

    it("places a frame node in page coordinates rather than the frame's own", async () => {
        const { session } = fixtureSession(page([iframe(formFrame([FRAME_FIELD]))]));
        const snapshot = await new PageState().capture(session, {});
        // The field sits at (10, 20) inside a frame whose content starts at (36, 46) on the page.
        expect(snapshot.nodes.find(node => node.name === 'Address')?.center).toEqual({ x: 121, y: 76 });
    });

    it("subtracts a scrolled frame's own offset, because its content has moved up", async () => {
        const { session } = fixtureSession(page([iframe(formFrame([FRAME_FIELD], { scroll: { x: 0, y: 25 } }))]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')?.center).toEqual({ x: 121, y: 51 });
    });

    it('marks a frame node off-screen once its real page position is known', async () => {
        // 700 is inside a 720-tall viewport on its own, and outside it once the frame is placed.
        const deep = { ...FRAME_FIELD, bounds: [10, 700, 150, 20] as [number, number, number, number] };
        const { session } = fixtureSession(page([iframe(formFrame([deep]))]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')?.inViewport).toBe(false);
    });

    it('keeps two frames apart when their node ids collide', async () => {
        const second = formFrame([], {
            frameId: 'frame-2',
            root: {
                tag: 'HTML',
                backendNodeId: 199,
                role: 'RootWebArea',
                name: 'Second form',
                bounds: [0, 0, 800, 600],
                children: [{ ...FRAME_FIELD, backendNodeId: 200, name: 'Postcode' }],
            },
        });
        const { session } = fixtureSession(
            page([iframe(formFrame([FRAME_FIELD])), iframe(second, { backendNodeId: 21, name: 'Second' })])
        );
        const snapshot = await new PageState().capture(session, {});
        const refs = ['Address', 'Postcode'].map(name => snapshot.nodes.find(node => node.name === name)?.ref);
        expect(refs.filter(Boolean), 'both frames contribute their own control').toHaveLength(2);
        expect(refs[0]).not.toBe(refs[1]);
    });

    it('reaches a control two frames deep', async () => {
        const inner = formFrame([], {
            frameId: 'frame-2',
            root: {
                tag: 'HTML',
                backendNodeId: 299,
                role: 'RootWebArea',
                name: 'Inner',
                bounds: [0, 0, 700, 500],
                children: [{ ...FRAME_FIELD, backendNodeId: 300, name: 'Collection date' }],
            },
        });
        const outer = formFrame([iframe(inner, { backendNodeId: 250, name: 'Renderer' })]);
        const { session } = fixtureSession(page([iframe(outer)]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Collection date')?.ref).toBeDefined();
    });

    it('subtracts a horizontally scrolled frame too', async () => {
        const { session } = fixtureSession(page([iframe(formFrame([FRAME_FIELD], { scroll: { x: 30, y: 0 } }))]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')?.center).toEqual({ x: 91, y: 76 });
    });

    it('clips to what the frame shows, which is its box less its border and padding', async () => {
        // The frame's box is 100 tall from y=40 with 6px of border and padding on each side, so its
        // content runs from y=46 to y=134. A field at frame-y 90 lands at page-y 136, just outside;
        // clipping to the border box instead would have kept it on screen until 140.
        const low = { ...FRAME_FIELD, bounds: [10, 90, 150, 20] as [number, number, number, number] };
        const short = iframe(formFrame([low]), { bounds: [30, 40, 800, 100] });
        const { session } = fixtureSession(page([short]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')?.inViewport).toBe(false);
    });

    it('keeps a node that fits inside the frame content box', async () => {
        const fits = { ...FRAME_FIELD, bounds: [10, 40, 150, 20] as [number, number, number, number] };
        const short = iframe(formFrame([fits]), { bounds: [30, 40, 800, 100] });
        const { session } = fixtureSession(page([short]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')?.inViewport).toBe(true);
    });

    it('counts an out-of-process frame and offers its URL, since its content never arrives', async () => {
        // A cross-origin frame has an Iframe node in the top tree but no document in the snapshot,
        // which the fixture models as an IFRAME node holding no frame.
        const foreign: FixtureNode = {
            tag: 'IFRAME',
            backendNodeId: 30,
            role: 'Iframe',
            name: 'Payment',
            bounds: [0, 200, 400, 300],
            attributes: { src: 'https://payments.example.com/checkout' },
        };
        const { session } = fixtureSession(page([foreign]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.unreadableFrames).toBe(1);
        expect(snapshot.nodes.find(node => node.role === 'Iframe')?.properties?.url).toBe(
            'https://payments.example.com/checkout'
        );
    });

    it('does not read a frame painted at zero opacity, and counts it as unread', async () => {
        // A hosted form engine mounts its frame at opacity 0 and fades it in once sized, so a
        // snapshot taken in that window has to say a frame is missing rather than look complete.
        const invisible = iframe(formFrame([FRAME_FIELD]), { computed: { opacity: '0' } });
        const fixture = fixtureSession(page([invisible]));
        const snapshot = await new PageState().capture(fixture.session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')).toBeUndefined();
        expect(fixture.sent.filter(call => call.method === 'Accessibility.getFullAXTree')).toHaveLength(1);
        expect(snapshot.unreadableFrames).toBe(1);
    });

    it('counts a visibility-hidden frame as unread too', async () => {
        const hidden = iframe(formFrame([FRAME_FIELD]), { visibility: 'hidden' });
        const { session } = fixtureSession(page([hidden]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')).toBeUndefined();
        expect(snapshot.unreadableFrames).toBe(1);
    });

    it('marks a node scrolled out of sight inside its frame as off-screen', async () => {
        // 500 is inside the 720-tall viewport once the frame is placed, and below the frame's own
        // 100px box, so it is not on screen however the page coordinates read.
        const below = { ...FRAME_FIELD, bounds: [10, 500, 150, 20] as [number, number, number, number] };
        const short = iframe(formFrame([below]), { bounds: [30, 0, 800, 100] });
        const { session } = fixtureSession(page([short]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')?.inViewport).toBe(false);
    });

    it('does not read a frame its owner never laid out, and does not count it either', async () => {
        // A frame with no box shows nothing whatever happens next, unlike one that is merely
        // painted away, so it is not a frame the caller is missing.
        const hidden = iframe(formFrame([FRAME_FIELD]), { bounds: [0, 0, 0, 0] });
        const fixture = fixtureSession(page([BUTTON, hidden]));
        const snapshot = await new PageState().capture(fixture.session, {});
        expect(snapshot.nodes.find(node => node.name === 'Address')).toBeUndefined();
        expect(fixture.sent.filter(call => call.method === 'Accessibility.getFullAXTree')).toHaveLength(1);
        expect(snapshot.unreadableFrames).toBe(0);
    });

    it('reads at most 24 frames and counts the rest', async () => {
        const frames = Array.from({ length: 25 }, (_, at) =>
            iframe(
                formFrame([{ ...FRAME_FIELD, backendNodeId: 1000 + at, name: `Field ${at}` }], {
                    frameId: `frame-${at}`,
                    root: {
                        tag: 'HTML',
                        backendNodeId: 2000 + at,
                        role: 'RootWebArea',
                        name: 'Form',
                        bounds: [0, 0, 800, 600],
                    },
                }),
                { backendNodeId: 3000 + at, name: `Frame ${at}`, bounds: [0, 700 * at, 800, 600] }
            )
        );
        const fixture = fixtureSession(page(frames));
        const snapshot = await new PageState().capture(fixture.session, {});
        const reads = fixture.sent.filter(call => call.method === 'Accessibility.getFullAXTree');
        expect(reads, 'the top document plus the capped frames').toHaveLength(25);
        expect(snapshot.unreadableFrames).toBe(1);
        expect(
            snapshot.nodes.find(node => node.name === 'Field 24'),
            'the frame past the cap'
        ).toBeUndefined();
    });

    it('propagates a transport failure while reading a frame, instead of reporting a partial page', async () => {
        // Only a frame that went away is a per-frame condition. A dead session is not, and a
        // snapshot that hides it behind "one frame could not be read" sends the caller on to act
        // against a browser that is gone.
        const broken = formFrame([FRAME_FIELD], { readError: 'WebSocket is not open: readyState 3 (CLOSED)' });
        const { session } = fixtureSession(page([iframe(broken)]));
        await expect(new PageState().capture(session, {})).rejects.toThrow(/WebSocket is not open/);
    });

    it('redacts a value it cannot vouch for, when the frame re-rendered after the DOM snapshot', async () => {
        // The frame's tree is read a round trip after the DOM snapshot. A frame that hydrated in
        // between reports node ids the snapshot never saw, so nothing is known about the field
        // behind a value — including whether it is a secret. Unknown means redacted.
        const secret: FixtureNode = {
            ...FRAME_FIELD,
            attributes: { name: 'cvv', type: 'text' },
            inputValue: 'topsecret',
        };
        const { session } = fixtureSession(page([iframe(formFrame([secret], { rerendered: true }))]));
        const snapshot = await new PageState().capture(session, {});
        const field = snapshot.nodes.find(node => node.name === 'Address');
        expect(field, 'the field is still reported').toBeDefined();
        expect(field?.sensitive).toBe(true);
        expect(field?.value).toBe('[redacted:9 chars]');
        expect(snapshot.text).not.toContain('topsecret');
    });

    it('records the frame a ref lives in', async () => {
        const state = new PageState();
        const { session } = fixtureSession(page([BUTTON, iframe(formFrame([FRAME_FIELD]))]));
        const snapshot = await state.capture(session, {});
        const field = snapshot.nodes.find(node => node.name === 'Address');
        const save = snapshot.nodes.find(node => node.name === 'Save');
        expect(state.resolveRef(field?.ref ?? '').frameId).toBe('frame-1');
        expect(state.resolveRef(save?.ref ?? '').frameId).toBe('main-frame');
    });

    it('reports a frame ref as stale once that frame has loaded a new document', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON, iframe(formFrame([FRAME_FIELD], { loaderId: 'form-step-1' }))]));
        const first = await state.capture(fixture.session, {});
        const fieldRef = first.nodes.find(node => node.name === 'Address')?.ref ?? '';
        const saveRef = first.nodes.find(node => node.name === 'Save')?.ref ?? '';

        // The form moved to its second step: a new document with new node ids inside the frame,
        // while the top document, and its loader, stayed exactly as they were.
        const stepTwo = formFrame([{ ...FRAME_FIELD, backendNodeId: 101, name: 'Postcode' }], {
            loaderId: 'form-step-2',
        });
        fixture.setPage(page([BUTTON, iframe(stepTwo)]));
        const second = await state.capture(fixture.session, {});

        let error: SteelToolError | undefined;
        try {
            state.resolveRef(fieldRef);
        } catch (thrown) {
            error = thrown as SteelToolError;
        }
        expect(error?.code).toBe('stale_ref');
        expect(error?.details).toMatchObject({ reason: 'frame_navigated' });
        expect(error?.message).toMatch(/frame/i);
        expect(state.resolveRef(saveRef).backendNodeId, 'the top document did not change').toBe(10);
        expect(second.nodes.find(node => node.name === 'Postcode')?.ref).not.toBe(fieldRef);
    });

    it('counts a frame it could not read, rather than dropping it in silence', async () => {
        const gone = formFrame([], { frameId: 'frame-2', detached: true });
        const { session } = fixtureSession(page([iframe(gone, { backendNodeId: 22, name: 'Advert' })]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.unreadableFrames).toBe(1);
    });

    it('reports no unreadable frames on a page whose frames all answered', async () => {
        const { session } = fixtureSession(page([iframe(formFrame([FRAME_FIELD]))]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.unreadableFrames).toBe(0);
    });

    it('keeps the rest of the page when a frame detaches mid-capture', async () => {
        const gone = formFrame([{ ...FRAME_FIELD, backendNodeId: 400, name: 'Gone' }], {
            frameId: 'frame-2',
            detached: true,
        });
        const { session } = fixtureSession(
            page([BUTTON, iframe(formFrame([FRAME_FIELD])), iframe(gone, { backendNodeId: 22, name: 'Advert' })])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'Save')?.ref, 'the page survives').toBeDefined();
        expect(snapshot.nodes.find(node => node.name === 'Address')?.ref, 'the live frame survives').toBeDefined();
        expect(snapshot.nodes.find(node => node.name === 'Gone')).toBeUndefined();
    });
});

describe('identityChanged', () => {
    const at = (role: string, name: string) => ({ role, name });

    it('treats an identical role and name as unchanged', () => {
        expect(identityChanged(at('button', 'Save'), at('button', 'Save'))).toBe(false);
    });

    it('treats a role change as changed, because that is a different kind of element', () => {
        expect(identityChanged(at('button', 'Save'), at('link', 'Save'))).toBe(true);
    });

    it('rejects a swap to a different action, which is the hazard worth failing on', () => {
        expect(identityChanged(at('button', 'Save'), at('button', 'Delete everything'))).toBe(true);
        expect(identityChanged(at('button', 'Cancel'), at('button', 'Confirm purchase'))).toBe(true);
        expect(identityChanged(at('link', 'Next page'), at('link', 'Unsubscribe'))).toBe(true);
    });

    it('rejects any other relabel too, rather than guessing which ones are cosmetic', () => {
        // Telling "Save became Saving…" apart from "Save became Delete" needs a similarity
        // threshold, and a wrong guess clicks the wrong button. The caller re-reads instead.
        expect(identityChanged(at('button', 'Save'), at('button', 'Saving…'))).toBe(true);
        expect(identityChanged(at('button', 'Save'), at('button', 'Save changes'))).toBe(true);
    });

    it('does not fail on a name that only became available, or went away', () => {
        expect(identityChanged(at('button', ''), at('button', 'Save'))).toBe(false);
        expect(identityChanged(at('button', 'Save'), at('button', ''))).toBe(false);
    });

    it('ignores case and surrounding whitespace', () => {
        expect(identityChanged(at('button', ' Save '), at('button', 'save'))).toBe(false);
    });

    it('does not treat two short unrelated names as the same because they share a letter', () => {
        expect(identityChanged(at('button', 'No'), at('button', 'Next'))).toBe(true);
    });
});

describe('PageState.resolveRef', () => {
    it('resolves a live ref to its backend node', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        expect(state.resolveRef('@e1').backendNodeId).toBe(10);
    });

    it('reports an unknown ref as not found rather than as stale', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        expect(catchSync(() => state.resolveRef('@e99'))?.code).toBe('ref_not_found');
    });

    it('reports a navigation as the reason when the document changed', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        fixture.setPage(page([BUTTON], { loaderId: 'loader-2' }));
        await state.capture(fixture.session, {});

        const error = catchSync(() => state.resolveRef('@e1'));
        // The button survived the reload under a fresh loaderId, so the old ref is gone.
        expect(error?.code).toBe('stale_ref');
        expect(error?.message).toMatch(/page navigated/i);
    });

    it('reports node removal when the element disappeared from the current snapshot', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        fixture.setPage(page([]));
        await state.capture(fixture.session, {});

        const error = catchSync(() => state.resolveRef('@e1'));
        expect(error?.code).toBe('stale_ref');
        expect(error?.message).toMatch(/removed from the DOM/i);
    });

    it('flags a target whose role or accessible name changed since the snapshot', async () => {
        const state = new PageState();
        const fixture = fixtureSession(page([BUTTON]));
        await state.capture(fixture.session, {});
        const recorded = state.resolveRef('@e1');

        fixture.setPage(page([{ ...BUTTON, name: 'Delete everything' }]));
        await state.capture(fixture.session, {});

        const error = catchSync(() => state.assertIdentityUnchanged('@e1', recorded));
        expect(error?.code).toBe('stale_ref');
        expect(error?.message).toMatch(/changed role or accessible name/i);
    });
});

describe('PageState.capture — untrusted content handling', () => {
    it('redacts the value of a password input', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'INPUT',
                    backendNodeId: 20,
                    role: 'textbox',
                    name: 'Password',
                    attributes: { type: 'password', name: 'password' },
                    inputValue: 'hunter2',
                    bounds: [0, 0, 100, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        const field = snapshot.nodes.find(node => node.name === 'Password');
        expect(field?.value).toBe('[redacted:7 chars]');
        expect(snapshot.text).not.toContain('hunter2');
    });

    it('keeps the value of an ordinary text input', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'INPUT',
                    backendNodeId: 21,
                    role: 'textbox',
                    name: 'City',
                    attributes: { type: 'text', name: 'city' },
                    inputValue: 'Zagreb',
                    bounds: [0, 0, 100, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.name === 'City')?.value).toBe('Zagreb');
    });

    it('strips invisible characters smuggled into an accessible name', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, name: 'Sa​ve' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.name).toBe('Save');
    });

    it('defangs a markdown link smuggled into an accessible name', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, name: '![x](https://evil.test/leak)' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.name).not.toContain('](');
    });
});

describe('PageState.capture — name synthesis', () => {
    it('synthesises a name for an unnamed button and marks it inferred', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'BUTTON',
                    backendNodeId: 30,
                    role: 'button',
                    name: '',
                    attributes: { 'aria-label': '', title: 'Close dialog' },
                    bounds: [0, 0, 20, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        const button = snapshot.nodes.find(node => node.role === 'button');
        expect(button?.name).toBe('Close dialog');
        expect(button?.nameInferred).toBe(true);
    });

    it('falls back through alt, placeholder and name attributes', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'INPUT',
                    backendNodeId: 31,
                    role: 'textbox',
                    name: '',
                    attributes: { placeholder: 'Search products' },
                    bounds: [0, 0, 100, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'textbox')?.name).toBe('Search products');
    });

    it('does not mark a real accessible name as inferred', async () => {
        const { session } = fixtureSession(page([BUTTON]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.nodes.find(node => node.role === 'button')?.nameInferred).toBe(false);
    });
});

describe('renderSnapshot', () => {
    it('renders one line per node with role, name and ref', async () => {
        const { session } = fixtureSession(page([BUTTON]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text).toContain('button "Save" @e1');
    });

    it('marks inferred names and off-screen nodes', async () => {
        const { session } = fixtureSession(
            page([
                {
                    tag: 'BUTTON',
                    backendNodeId: 40,
                    role: 'button',
                    name: '',
                    attributes: { title: 'Menu' },
                    bounds: [0, 5000, 20, 20],
                },
            ])
        );
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text).toContain('(inferred)');
        expect(snapshot.text).toContain('[off-screen]');
    });

    it('never emits a ref for a node that has none', async () => {
        const { session } = fixtureSession(page([{ ...BUTTON, pointerEvents: 'none' }]));
        const snapshot = await new PageState().capture(session, {});
        expect(snapshot.text).toContain('button "Save"');
        expect(snapshot.text).not.toMatch(/@e\d/);
    });

    it('indents by tree depth so structure survives the flattening', () => {
        const text = renderSnapshot([
            {
                role: 'main',
                name: '',
                nameInferred: false,
                sensitive: false,
                backendNodeId: 1,
                depth: 0,
                inViewport: true,
                interactive: false,
            },
            {
                role: 'button',
                name: 'Go',
                nameInferred: false,
                sensitive: false,
                backendNodeId: 2,
                depth: 1,
                inViewport: true,
                interactive: true,
                ref: '@e1',
            },
        ]);
        const lines = text.split('\n');
        expect(lines[0]).toMatch(/^- main/);
        expect(lines[1]).toMatch(/^ {2}- button "Go" @e1/);
    });
});

describe('findInSnapshot', () => {
    const nodes = [
        {
            role: 'button',
            name: 'Save changes',
            nameInferred: false,
            sensitive: false,
            backendNodeId: 1,
            depth: 1,
            inViewport: true,
            interactive: true,
            ref: '@e1',
        },
        {
            role: 'link',
            name: 'Save as draft',
            nameInferred: false,
            sensitive: false,
            backendNodeId: 2,
            depth: 1,
            inViewport: true,
            interactive: true,
            ref: '@e2',
        },
        {
            role: 'heading',
            name: 'Settings',
            nameInferred: false,
            sensitive: false,
            backendNodeId: 3,
            depth: 0,
            inViewport: true,
            interactive: false,
        },
    ];

    it('matches on a case-insensitive substring of the name', () => {
        expect(findInSnapshot(nodes, { text: 'save' }).map(node => node.ref)).toEqual(['@e1', '@e2']);
    });

    it('matches on a regular expression', () => {
        expect(findInSnapshot(nodes, { regex: '^Save c' }).map(node => node.ref)).toEqual(['@e1']);
    });

    it('filters by role', () => {
        expect(findInSnapshot(nodes, { text: 'save', role: 'link' }).map(node => node.ref)).toEqual(['@e2']);
    });

    it('can restrict results to nodes that can actually be targeted', () => {
        expect(findInSnapshot(nodes, { text: 'settings', interactiveOnly: true })).toEqual([]);
        expect(findInSnapshot(nodes, { text: 'settings' })).toHaveLength(1);
    });

    it('puts targetable matches first, because a match with no ref cannot be acted on', () => {
        const withLabel = [
            {
                role: 'StaticText',
                name: 'Email',
                nameInferred: false,
                sensitive: false,
                backendNodeId: 9,
                depth: 1,
                inViewport: true,
                interactive: false,
            },
            {
                role: 'textbox',
                name: 'Email',
                nameInferred: false,
                sensitive: false,
                backendNodeId: 10,
                depth: 1,
                inViewport: true,
                interactive: true,
                ref: '@e5',
            },
        ];
        expect(findInSnapshot(withLabel, { text: 'email' })[0]?.ref).toBe('@e5');
    });

    it('rejects an invalid regular expression with an actionable message', () => {
        expect(() => findInSnapshot(nodes, { regex: '([' })).toThrow(/not a valid regular expression/i);
    });
});

/** Runs a synchronous call and returns the SteelToolError it threw, if any. */
function catchSync(fn: () => unknown): SteelToolError | undefined {
    try {
        fn();
        return undefined;
    } catch (error) {
        return error as SteelToolError;
    }
}
