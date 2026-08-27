// ABOUTME: Guards the vendored skill catalog's shape: one skill per directory, frontmatter that
// ABOUTME: agrees with its URI, and nothing executable riding along with the guidance.
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../../src/core/instructions.js';
import { SKILL_CATALOG } from '../../src/core/skills/catalog.generated.js';
import { buildSkillResources, SKILL_RESOURCES } from '../../src/core/skills/resources.js';

const SKILL_NAMES = [
    'steel-browser',
    'steel-developer',
    'steel-reliability',
    'steel-session-debugging',
    'steel-skill-creator',
] as const;

describe('the vendored skill catalog', () => {
    it('carries exactly the five published Steel skills, each with a SKILL.md', () => {
        const skills = new Set(SKILL_CATALOG.map(file => file.path.split('/')[0]));
        expect([...skills].sort()).toEqual([...SKILL_NAMES]);

        for (const name of SKILL_NAMES) {
            expect(
                SKILL_CATALOG.some(file => file.path === `${name}/SKILL.md`),
                `${name} must keep its entry point`
            ).toBe(true);
        }
    });

    it('holds markdown guidance only, so no executable or eval file can reach a model', () => {
        for (const file of SKILL_CATALOG) {
            expect(file.path.endsWith('.md'), `${file.path} is not markdown`).toBe(true);
        }
    });
});

describe('the skill resource set', () => {
    it('serves one skill:// URI per catalog file, and no two files share a URI', () => {
        expect(SKILL_RESOURCES).toHaveLength(SKILL_CATALOG.length);
        const uris = SKILL_RESOURCES.map(resource => resource.uri);
        expect(new Set(uris).size).toBe(uris.length);
    });

    it('puts every SKILL.md at skill://<name>/SKILL.md, with the frontmatter name agreeing', () => {
        for (const name of SKILL_NAMES) {
            const entry = SKILL_RESOURCES.find(resource => resource.uri === `skill://${name}/SKILL.md`);
            expect(entry, `${name} has no SKILL.md resource`).toBeDefined();
            expect(entry?.title).toBe(name);
            // The body must open with frontmatter naming the skill; the loader rejects a mismatch,
            // so reaching here means the URI and the content agree.
            expect(entry?.text).toMatch(new RegExp(`^---\\nname: ${name}\\b`));
        }
    });

    it('describes each SKILL.md from its frontmatter, so the list entry routes like the skill does', () => {
        const browser = SKILL_RESOURCES.find(resource => resource.uri === 'skill://steel-browser/SKILL.md');
        expect(browser?.description).toContain('JavaScript-rendered pages');
    });

    it('serves every file as markdown', () => {
        for (const resource of SKILL_RESOURCES) {
            expect(resource.mimeType).toBe('text/markdown');
        }
    });
});

describe('the catalog allowlist', () => {
    // Mirrors INCLUDED_WITHIN_SKILL in scripts/sync-skills.mjs. The `.md` rule alone would let a
    // future eval rubric or script doc ride along, so the vendored set is pinned here too.
    const WITHIN_SKILL = [/^SKILL\.md$/, /^README\.md$/, /^references\//, /^templates\//];

    it('keeps every vendored file at an allowlisted place inside its skill', () => {
        for (const file of SKILL_CATALOG) {
            const within = file.path.slice(file.path.indexOf('/') + 1);
            expect(
                WITHIN_SKILL.some(pattern => pattern.test(within)),
                `${file.path} is outside the allowlist`
            ).toBe(true);
        }
    });

    it('gives every file a URI that survives normalization, so no entry lists but never reads', () => {
        for (const file of SKILL_CATALOG) {
            const uri = `skill://${file.path}`;
            expect(new URL(uri).toString(), file.path).toBe(uri);
        }
    });
});

describe('the catalog loader', () => {
    const entryPoint = (frontmatter: string): { path: string; text: string } => ({
        path: 'demo/SKILL.md',
        text: `---\n${frontmatter}\n---\n\nBody.\n`,
    });

    it('refuses a SKILL.md whose frontmatter name disagrees with its directory', () => {
        expect(() => buildSkillResources([entryPoint('name: other\ndescription: Demo skill.')])).toThrow(
            'demo/SKILL.md: frontmatter name other does not match demo'
        );
    });

    it('refuses a SKILL.md without a description, which no model could be routed to', () => {
        expect(() => buildSkillResources([entryPoint('name: demo')])).toThrow(
            'demo/SKILL.md: SKILL.md frontmatter has no description'
        );
    });

    it('refuses a path that does not survive URI normalization', () => {
        expect(() => buildSkillResources([{ path: 'demo/has space.md', text: 'Body.' }])).toThrow(
            'demo/has space.md: does not survive URI normalization and could not be read back'
        );
    });
});

describe('the instructions pointer', () => {
    it('names the browsing skill and the resource list, so hosts without skills support still route', () => {
        expect(SERVER_INSTRUCTIONS).toContain('skill://steel-browser/SKILL.md');
        expect(SERVER_INSTRUCTIONS).toContain('resources/list');
    });
});
