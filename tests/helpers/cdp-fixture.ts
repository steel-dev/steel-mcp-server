// ABOUTME: Builds a fake page-scoped CDP session from a declarative node tree, producing the exact
// ABOUTME: Accessibility.getFullAXTree and DOMSnapshot.captureSnapshot payloads the pipeline joins.
import { COMPUTED_STYLES } from '../../src/core/snapshot.js';
import type { CdpEventParams, CdpSession } from '../../src/core/steel/cdp.js';

/** One node in a fixture page. Omitting `bounds` models a node the layout engine never rendered. */
export interface FixtureNode {
    tag: string;
    backendNodeId: number;
    /** ARIA role. Omit to leave the node out of the accessibility tree entirely. */
    role?: string;
    name?: string;
    /** Marked ignored by Chrome (aria-hidden, presentational, etc.). */
    ignored?: boolean;
    attributes?: Record<string, string>;
    inputValue?: string;
    /** `[x, y, width, height]` in CSS pixels. Absent means not in the layout tree. */
    bounds?: [number, number, number, number];
    pointerEvents?: string;
    visibility?: string;
    /** Computed styles beyond the defaults, such as an iframe's border and padding. */
    computed?: Record<string, string>;
    /** AX properties such as level, checked, disabled. */
    properties?: Record<string, string | number | boolean>;
    children?: FixtureNode[];
    /** The document this node holds, which makes it an iframe with its own frame and AX tree. */
    frame?: FixtureFrame;
}

/** A document nested inside a fixture page, with its own coordinate space and node ids. */
export interface FixtureFrame {
    root: FixtureNode;
    frameId: string;
    /** The loader of the frame's current document. Defaults to one derived from the frame id. */
    loaderId?: string;
    url?: string;
    scroll?: { x: number; y: number };
    /** Models a frame that went away between the DOM snapshot and the read of its tree. */
    detached?: boolean;
    /** Models a transport or session failure while reading this frame's tree. */
    readError?: string;
    /**
     * Models a frame that replaced its DOM between the DOM snapshot and the read of its tree: the
     * accessibility tree names backend node ids the DOM snapshot has never seen.
     */
    rerendered?: boolean;
}

export interface FixturePage {
    root: FixtureNode;
    loaderId?: string;
    url?: string;
    title?: string;
    frameId?: string;
    viewport?: { width: number; height: number };
    scroll?: { x: number; y: number };
}

interface FlatNode {
    node: FixtureNode;
    index: number;
    parentIndex: number;
}

/** One document's worth of the fixture: its own nodes, indices and frame identity. */
interface FixtureDocument {
    frameId: string;
    loaderId: string;
    url: string;
    scroll: { x: number; y: number };
    flat: FlatNode[];
    detached: boolean;
    readError?: string | undefined;
    /** Added to every backend node id the accessibility tree reports, to model a re-rendered frame. */
    axIdOffset: number;
    /** Which node of which document holds this one, absent on the top document. */
    owner?: { documentIndex: number; nodeIndex: number };
}

/** Backend node ids a re-rendered frame reports, chosen to collide with nothing the fixture issues. */
const RERENDERED_ID_OFFSET = 100_000;

/** Flattens one document, stopping at an iframe rather than walking into the document it holds. */
function flatten(root: FixtureNode): FlatNode[] {
    const flat: FlatNode[] = [];
    const walk = (node: FixtureNode, parentIndex: number): void => {
        const index = flat.length;
        flat.push({ node, index, parentIndex });
        for (const child of node.children ?? []) walk(child, index);
    };
    walk(root, -1);
    return flat;
}

/** Splits a fixture page into one entry per frame, top document first, with per-document indices. */
function collectDocuments(page: FixturePage): FixtureDocument[] {
    const documents: FixtureDocument[] = [
        {
            frameId: page.frameId ?? 'main-frame',
            loaderId: page.loaderId ?? 'loader-1',
            url: page.url ?? 'https://example.com/',
            scroll: page.scroll ?? { x: 0, y: 0 },
            flat: flatten(page.root),
            detached: false,
            axIdOffset: 0,
        },
    ];

    for (let at = 0; at < documents.length; at++) {
        for (const entry of documents[at]!.flat) {
            const frame = entry.node.frame;
            if (!frame) continue;
            documents.push({
                frameId: frame.frameId,
                loaderId: frame.loaderId ?? `loader-${frame.frameId}`,
                url: frame.url ?? 'https://example.com/frame',
                scroll: frame.scroll ?? { x: 0, y: 0 },
                flat: flatten(frame.root),
                detached: frame.detached ?? false,
                readError: frame.readError,
                axIdOffset: frame.rerendered ? RERENDERED_ID_OFFSET : 0,
                owner: { documentIndex: at, nodeIndex: entry.index },
            });
        }
    }
    return documents;
}

interface FrameTree {
    frame: { id: string; loaderId: string; url: string };
    childFrames?: FrameTree[];
}

/** The `Page.getFrameTree` answer: every document nested under the one that holds it. */
function frameTreeOf(documents: FixtureDocument[], at: number): FrameTree {
    const document = documents[at]!;
    const children = documents
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) => candidate.owner?.documentIndex === at)
        .map(({ index }) => frameTreeOf(documents, index));
    return {
        frame: { id: document.frameId, loaderId: document.loaderId, url: document.url },
        ...(children.length > 0 ? { childFrames: children } : {}),
    };
}

class StringTable {
    readonly strings: string[] = [];
    private readonly index = new Map<string, number>();

    intern(value: string): number {
        const existing = this.index.get(value);
        if (existing !== undefined) return existing;
        this.strings.push(value);
        const at = this.strings.length - 1;
        this.index.set(value, at);
        return at;
    }
}

/** The computed styles the snapshot pipeline asks DOMSnapshot for. Read back by position, so the
 * fixture has to emit them in the order the pipeline requests them. */
export const REQUESTED_COMPUTED_STYLES: readonly string[] = COMPUTED_STYLES;

const DEFAULT_COMPUTED: Record<string, string> = {
    'pointer-events': 'auto',
    visibility: 'visible',
    display: 'block',
    opacity: '1',
    'border-left-width': '0px',
    'border-top-width': '0px',
    'padding-left': '0px',
    'padding-top': '0px',
};

function buildAxTree(flat: FlatNode[], idOffset: number) {
    const axNodes = flat
        .filter(entry => entry.node.role !== undefined)
        .map(entry => {
            const { node } = entry;
            const childIds = flat
                .filter(child => child.parentIndex === entry.index && child.node.role !== undefined)
                .map(child => String(child.index));
            return {
                nodeId: String(entry.index),
                ignored: node.ignored ?? false,
                role: { type: 'role', value: node.role },
                name: node.name === undefined ? undefined : { type: 'computedString', value: node.name },
                value: node.inputValue === undefined ? undefined : { type: 'string', value: node.inputValue },
                properties: Object.entries(node.properties ?? {}).map(([name, value]) => ({
                    name,
                    value: { type: typeof value, value },
                })),
                childIds,
                backendDOMNodeId: node.backendNodeId + idOffset,
                parentId: entry.parentIndex >= 0 ? String(entry.parentIndex) : undefined,
            };
        });
    return { nodes: axNodes };
}

function buildDomSnapshot(documents: FixtureDocument[], page: FixturePage) {
    const table = new StringTable();

    // Which node in this document holds which other document, in the shape Chrome sends: a node
    // index paired with the index of the held document in this same list.
    const heldBy = documents.map(() => ({ index: [] as number[], value: [] as number[] }));
    documents.forEach((document, at) => {
        if (!document.owner) return;
        const link = heldBy[document.owner.documentIndex]!;
        link.index.push(document.owner.nodeIndex);
        link.value.push(at);
    });

    const built = documents.map((document, at) => {
        const { flat } = document;
        const layoutNodeIndex: number[] = [];
        const layoutStyles: number[][] = [];
        const layoutBounds: number[][] = [];
        const inputValueIndex: number[] = [];
        const inputValueValue: number[] = [];
        const isClickableIndex: number[] = [];

        for (const { node, index } of flat) {
            if (node.inputValue !== undefined) {
                inputValueIndex.push(index);
                inputValueValue.push(table.intern(node.inputValue));
            }
            if (node.role === 'button' || node.role === 'link' || node.tag === 'BUTTON' || node.tag === 'A') {
                isClickableIndex.push(index);
            }
            if (!node.bounds) continue;
            const computed: Record<string, string> = {
                ...DEFAULT_COMPUTED,
                'pointer-events': node.pointerEvents ?? DEFAULT_COMPUTED['pointer-events']!,
                visibility: node.visibility ?? DEFAULT_COMPUTED.visibility!,
                ...node.computed,
            };
            layoutNodeIndex.push(index);
            layoutStyles.push(REQUESTED_COMPUTED_STYLES.map(name => table.intern(computed[name] ?? '')));
            layoutBounds.push([...node.bounds]);
        }

        return {
            documentURL: table.intern(document.url),
            title: table.intern(at === 0 ? (page.title ?? 'Example') : ''),
            baseURL: table.intern(document.url),
            frameId: table.intern(document.frameId),
            nodes: {
                parentIndex: flat.map(entry => entry.parentIndex),
                nodeType: flat.map(entry => (entry.node.tag === '#text' ? 3 : 1)),
                nodeName: flat.map(entry => table.intern(entry.node.tag)),
                nodeValue: flat.map(entry => table.intern(entry.node.attributes?.['#value'] ?? '')),
                backendNodeId: flat.map(entry => entry.node.backendNodeId),
                attributes: flat.map(entry =>
                    Object.entries(entry.node.attributes ?? {})
                        .filter(([name]) => name !== '#value')
                        .flatMap(([name, value]) => [table.intern(name), table.intern(value)])
                ),
                inputValue: { index: inputValueIndex, value: inputValueValue },
                isClickable: { index: isClickableIndex },
                contentDocumentIndex: heldBy[at],
            },
            layout: {
                nodeIndex: layoutNodeIndex,
                styles: layoutStyles,
                bounds: layoutBounds,
                text: layoutNodeIndex.map(() => -1),
            },
            scrollOffsetX: document.scroll.x,
            scrollOffsetY: document.scroll.y,
        };
    });

    return { strings: table.strings, documents: built };
}

export interface FixtureSession {
    session: CdpSession;
    sent: Array<{ method: string; params: Record<string, unknown> }>;
    emit(event: string, params: CdpEventParams): void;
    /** Replaces the page the fixture serves, modelling a navigation or a DOM change. */
    setPage(page: FixturePage): void;
    /** Canned answers for methods the pipeline calls but the fixture does not model. */
    stub(method: string, handler: (params: Record<string, unknown>) => unknown): void;
}

/** Builds a fake page-scoped CDP session that answers the four calls the snapshot pipeline makes. */
export function fixtureSession(initialPage: FixturePage): FixtureSession {
    let page = initialPage;
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const listeners = new Map<string, Set<(params: CdpEventParams) => void>>();
    const stubs = new Map<string, (params: Record<string, unknown>) => unknown>();

    const session: CdpSession = {
        async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
            sent.push({ method, params });
            const stub = stubs.get(method);
            if (stub) return stub(params) as T;

            const documents = collectDocuments(page);
            switch (method) {
                case 'Page.getFrameTree':
                    return { frameTree: frameTreeOf(documents, 0) } as T;
                case 'Accessibility.getFullAXTree': {
                    // Chrome answers for one frame: the page's own when asked for no frame in
                    // particular, and it refuses a frame it does not have.
                    const asked = params.frameId as string | undefined;
                    const document =
                        asked === undefined ? documents[0] : documents.find(entry => entry.frameId === asked);
                    if (!document || document.detached) throw new Error('Frame with the given frameId is not found.');
                    if (document.readError !== undefined) throw new Error(document.readError);
                    return buildAxTree(document.flat, document.axIdOffset) as T;
                }
                case 'DOMSnapshot.captureSnapshot':
                    return buildDomSnapshot(documents, page) as T;
                case 'Page.getLayoutMetrics':
                    return {
                        cssLayoutViewport: {
                            clientWidth: page.viewport?.width ?? 1280,
                            clientHeight: page.viewport?.height ?? 720,
                            pageX: page.scroll?.x ?? 0,
                            pageY: page.scroll?.y ?? 0,
                        },
                        cssContentSize: { width: 1280, height: 4000 },
                    } as T;
                case 'Runtime.evaluate':
                    return { result: { value: false } } as T;
                default:
                    return {} as T;
            }
        },
        on(event, listener) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
            return () => set.delete(listener);
        },
        async close() {},
    };

    return {
        session,
        sent,
        emit(event, params) {
            for (const listener of listeners.get(event) ?? []) listener(params);
        },
        setPage(next) {
            page = next;
        },
        stub(method, handler) {
            stubs.set(method, handler);
        },
    };
}
