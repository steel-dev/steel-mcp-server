// ABOUTME: Serves the vendored Steel skills as skill:// resources over the plain resources
// ABOUTME: primitives, so every host can read them with no extension support required.
import type { McpServer } from '@modelcontextprotocol/server';
import { type CatalogFile, SKILL_CATALOG } from './catalog.generated.js';

/** The MIME type every catalog file is served under; the catalog is markdown guidance only. */
export const SKILL_MIME_TYPE = 'text/markdown';

/**
 * One hour, the same span the server-level `tools/list` hint and the session viewer use.
 *
 * The skill bodies are build-time static and carry nothing derived from a principal, so a shared
 * cache may hold them even though the server-level `resources/read` hint stays private.
 */
const PUBLIC_CACHE_TTL_MS = 3_600_000;

/** The registration surface this module needs; keeps the module testable without an McpServer. */
export type ResourceHost = Pick<McpServer, 'registerResource'>;

/** One catalog file resolved to the fields `registerResource` and `resources/read` need. */
export interface SkillResource {
    /** `skill://<skill-name>/<file-path>`, the URI shape the MCP Skills Extension draft specifies. */
    readonly uri: string;
    /** The upstream-relative path, used as the resource's machine name so it stays unique. */
    readonly name: string;
    /** Set on SKILL.md entries only, from frontmatter; hosts show it as the human label. */
    readonly title: string | undefined;
    readonly description: string;
    readonly mimeType: string;
    readonly text: string;
}

/** Reads the `name` and `description` scalars from SKILL.md frontmatter without a YAML dependency. */
export function frontmatterScalars(text: string): { name?: string; description?: string } {
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
    if (block === undefined) return {};
    const scalar = (key: string): string | undefined => {
        const raw = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(block)?.[1];
        return raw?.replace(/^['"]|['"]$/g, '');
    };
    return { name: scalar('name'), description: scalar('description') };
}

function descriptionFor(file: CatalogFile, skillName: string, frontmatterDescription: string | undefined): string {
    if (file.path === `${skillName}/SKILL.md`) {
        // Agent Skills requires a description; a skill without one cannot be routed to, so the build
        // stops here rather than shipping an entry point a model has no reason to read.
        if (frontmatterDescription === undefined || frontmatterDescription === '') {
            throw new Error(`${file.path}: SKILL.md frontmatter has no description`);
        }
        return frontmatterDescription;
    }
    return file.path === `${skillName}/README.md`
        ? `Overview of the ${skillName} skill.`
        : `Supporting file for the ${skillName} skill.`;
}

/**
 * Maps catalog files to resources, refusing a file that could not serve correctly.
 * Exported so the refusal paths stay testable against a synthetic bad catalog.
 */
export function buildSkillResources(catalog: readonly CatalogFile[]): SkillResource[] {
    return catalog.map(file => {
        // The first path segment names the skill; a catalog file without one is its own skill name.
        const skillName = file.path.split('/')[0] ?? file.path;
        const isEntryPoint = file.path === `${skillName}/SKILL.md`;
        const { name, description } = frontmatterScalars(file.text);
        if (isEntryPoint && name !== skillName) {
            // The URI carries the directory name, so frontmatter that disagrees would publish a
            // skill whose own content names something else. The sync refuses this; the loader
            // refuses it again so a hand-edited catalog cannot ship either.
            throw new Error(`${file.path}: frontmatter name ${name ?? '(none)'} does not match ${skillName}`);
        }
        const uri = `skill://${file.path}`;
        // The sync refuses these paths upstream; the loader checks again so a hand-edited catalog
        // cannot publish a resource whose read would resolve to a different URI.
        if (new URL(uri).toString() !== uri) {
            throw new Error(`${file.path}: does not survive URI normalization and could not be read back`);
        }
        return {
            uri,
            name: file.path,
            title: isEntryPoint ? skillName : undefined,
            description: descriptionFor(file, skillName, description),
            mimeType: SKILL_MIME_TYPE,
            text: file.text,
        };
    });
}

/**
 * Resolved once at module load, not per connection: `createSteelMcpServer` must stay cheap, and a
 * malformed catalog should stop the process at startup rather than at the first client request.
 */
export const SKILL_RESOURCES: readonly SkillResource[] = buildSkillResources(SKILL_CATALOG);

/** Registers every catalog file as one readable resource, in catalog order. */
export function registerSkillResources(server: ResourceHost): void {
    for (const resource of SKILL_RESOURCES) {
        server.registerResource(
            resource.name,
            resource.uri,
            {
                title: resource.title,
                description: resource.description,
                mimeType: resource.mimeType,
                cacheHint: { ttlMs: PUBLIC_CACHE_TTL_MS, cacheScope: 'public' },
            },
            () => ({
                contents: [
                    {
                        uri: resource.uri,
                        mimeType: resource.mimeType,
                        text: resource.text,
                    },
                ],
            })
        );
    }
}
