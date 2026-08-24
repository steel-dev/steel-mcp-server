// ABOUTME: Unit tests for the sectioned response envelope and the change signal, which must never
// ABOUTME: report a bare success when an action produced no observable effect.
import { describe, expect, it } from 'vitest';
import { describeChange, renderEnvelope, successResult } from '../../src/core/envelope.js';

describe('renderEnvelope', () => {
    it('emits sections in a fixed order regardless of the order they were supplied', () => {
        const text = renderEnvelope({
            snapshot: 'tree',
            result: 'Navigated',
            pageState: 'https://example.com/ — Example',
        });
        expect(text.indexOf('### Result')).toBeLessThan(text.indexOf('### Page state'));
        expect(text.indexOf('### Page state')).toBeLessThan(text.indexOf('### Snapshot'));
    });

    it('omits sections that were not supplied', () => {
        expect(renderEnvelope({ result: 'ok' })).not.toContain('### Snapshot');
    });

    it('renders notes as a list', () => {
        const text = renderEnvelope({ result: 'ok', notes: ['first', 'second'] });
        expect(text).toContain('### Notes');
        expect(text).toContain('- first');
        expect(text).toContain('- second');
    });

    it('renders the pagination hint so a truncated read is never silent', () => {
        const text = renderEnvelope({ result: 'ok', pagination: 'Truncated. cursor=abc' });
        expect(text).toContain('### Pagination');
        expect(text).toContain('cursor=abc');
    });
});

describe('describeChange', () => {
    it('reports a navigation with its destination', () => {
        expect(
            describeChange({
                navigated: true,
                navigatedToUrl: 'https://example.com/next',
                domMutated: true,
                timedOut: false,
            })
        ).toMatch(/navigated to https:\/\/example\.com\/next/i);
    });

    it('reports a DOM change when nothing navigated', () => {
        expect(
            describeChange({ navigated: false, navigatedToUrl: undefined, domMutated: true, timedOut: false })
        ).toMatch(/dom changed/i);
    });

    it('says plainly that nothing changed rather than reporting success', () => {
        const text = describeChange({
            navigated: false,
            navigatedToUrl: undefined,
            domMutated: false,
            timedOut: false,
        });
        expect(text).toMatch(/nothing changed/i);
        expect(text).not.toMatch(/^success/i);
        expect(text).toMatch(/wrong element|did not reach|no effect/i);
    });

    it('mentions a focus change when that is the only effect', () => {
        expect(
            describeChange({
                navigated: false,
                navigatedToUrl: undefined,
                domMutated: false,
                timedOut: false,
                focusChanged: true,
            })
        ).toMatch(/focus/i);
    });

    it('attributes a navigation to the target frame when that is where it happened', () => {
        expect(
            describeChange({
                navigated: true,
                navigatedToUrl: 'https://forms.example.com/step-2',
                navigatedInFrame: true,
                domMutated: false,
                timedOut: false,
            })
        ).toMatch(/frame.*navigated to https:\/\/forms\.example\.com\/step-2/i);
    });

    it('does not claim nothing changed when the target sits in a frame it could not observe', () => {
        const text = describeChange({
            navigated: false,
            navigatedToUrl: undefined,
            domMutated: false,
            timedOut: false,
            frameUnobserved: true,
        });
        expect(text).not.toMatch(/wrong element/i);
        expect(text).toMatch(/frame/i);
        expect(text).toMatch(/fresh snapshot/i);
        expect(text).toMatch(/not repeat/i);
    });

    it('adds the frame caveat to a focus-only change, since typing into a frame shows nothing else', () => {
        const text = describeChange({
            navigated: false,
            navigatedToUrl: undefined,
            domMutated: false,
            timedOut: false,
            focusChanged: true,
            frameUnobserved: true,
        });
        expect(text).toMatch(/focus/i);
        expect(text).toMatch(/frame/i);
        expect(text).not.toMatch(/nothing changed/i);
    });

    it('flags that the page was still busy when a budget expired', () => {
        expect(
            describeChange({ navigated: false, navigatedToUrl: undefined, domMutated: true, timedOut: true })
        ).toMatch(/still busy|did not settle/i);
    });
});

describe('successResult', () => {
    it('produces a non-error tool result carrying the rendered envelope', () => {
        const result = successResult({ result: 'Navigated' }, { url: 'https://example.com/' });
        expect(result.isError).toBeUndefined();
        expect((result.content[0] as { text: string }).text).toContain('### Result');
        expect(result.structuredContent).toEqual({ url: 'https://example.com/' });
    });

    it('appends extra content blocks such as resource links after the text', () => {
        const result = successResult({ result: 'Captured' }, undefined, [
            { type: 'resource_link', uri: 'https://files.steel.dev/a.png', name: 'a.png', mimeType: 'image/png' },
        ]);
        expect(result.content).toHaveLength(2);
        expect(result.content[1]).toMatchObject({ type: 'resource_link' });
    });

    it('can attach component-only result metadata without copying it into model-visible content', () => {
        const manifest = '#EXTM3U\nhttps://signed.example/segment.ts?secret=redacted';
        const result = successResult({ result: 'Replay is ready.' }, { replay: { state: 'ready' } }, [], {
            'steel/replay': { kind: 'hls', manifest },
        });

        expect(result._meta).toEqual({ 'steel/replay': { kind: 'hls', manifest } });
        expect(JSON.stringify(result.content)).not.toContain('signed.example');
        expect(JSON.stringify(result.structuredContent)).not.toContain('signed.example');
    });
});
