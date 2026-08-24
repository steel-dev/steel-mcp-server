// ABOUTME: Unit tests for the rendering helpers the stateful tools share, chiefly the one-line page
// ABOUTME: state that has to say when part of the page is missing from the snapshot.
import { describe, expect, it } from 'vitest';
import { pageStateLine } from '../../src/core/tools/shared.js';

const SNAPSHOT = { url: 'https://example.com/service', title: 'Service', snapshotId: 's3' };

describe('pageStateLine', () => {
    it('renders the URL, title and snapshot id when every frame was read', () => {
        const line = pageStateLine({ ...SNAPSHOT, unreadableFrames: 0 });
        expect(line).toBe('https://example.com/service — Service (snapshot s3)');
    });

    it('says how many frames could not be read, so a missing form is not mistaken for a complete page', () => {
        expect(pageStateLine({ ...SNAPSHOT, unreadableFrames: 1 })).toMatch(/1 frame could not be read/);
        expect(pageStateLine({ ...SNAPSHOT, unreadableFrames: 3 })).toMatch(/3 frames could not be read/);
        expect(pageStateLine({ ...SNAPSHOT, unreadableFrames: 3 })).toMatch(/anything inside is missing/);
    });

    it('leaves the title out when the page has none', () => {
        expect(pageStateLine({ ...SNAPSHOT, title: '', unreadableFrames: 0 })).toBe(
            'https://example.com/service (snapshot s3)'
        );
    });
});
