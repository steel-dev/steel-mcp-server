// ABOUTME: Regenerates src/core/skills/catalog.generated.ts from the steel-dev/skills repository so
// ABOUTME: the server serves the same skill content Steel publishes, without runtime network access.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { argv, exit, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The upstream revision the vendored catalog was generated from.
 *
 * Advancing it is a deliberate, reviewed act: the generated file records this value, and the content
 * reaches models verbatim, so a bump means re-reading what Steel would now be telling every agent.
 */
const DEFAULT_REF = '35bf278371312964a177f15b679b5e290f9ef275';

const REPO_OWNER = 'steel-dev';
const REPO_NAME = 'skills';

/** Markdown guidance only. Scripts (`*.mjs`) and eval fixtures (`*.json`) stay upstream. */
const INCLUDED_EXTENSION = '.md';

/**
 * What may be vendored from one skill directory, beyond the extension rule above.
 *
 * `evals/` fixtures are adversarial by design and `scripts/` is executable tooling; an `.md` file
 * that ever appears under either must not ride into the catalog on the extension alone.
 */
const INCLUDED_WITHIN_SKILL = [/^SKILL\.md$/, /^README\.md$/, /^references\//, /^templates\//];

const OUTPUT_PATH = fileURLToPath(new URL('../src/core/skills/catalog.generated.ts', import.meta.url));

function usage() {
    stderr.write('usage: sync-skills.mjs [--ref <git-ref>] [--source <checkout-dir>]\n');
    stderr.write('  --ref     upstream revision to vendor (default: the pinned revision)\n');
    stderr.write('  --source  read from a local checkout instead of GitHub\n');
    exit(2);
}

function parseArgs() {
    const options = { ref: DEFAULT_REF, source: undefined };
    const args = argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value || (flag !== '--ref' && flag !== '--source')) usage();
        if (flag === '--ref') options.ref = value;
        else options.source = value;
    }
    return options;
}

/** Lists and reads the upstream tree, either from a local checkout or over the GitHub API. */
function localSource(root, ref) {
    const walk = (dir) =>
        readdirSync(dir).flatMap((entry) => {
            const full = join(dir, entry);
            return statSync(full).isDirectory() ? walk(full) : [full];
        });
    return {
        listMarkdownFiles: async () =>
            walk(root)
                .filter((file) => file.endsWith(INCLUDED_EXTENSION))
                .map((file) => relative(root, file)),
        readText: async (path) => readFileSync(join(root, path), 'utf8'),
        resolvedRevision: async () => {
            // The generated header names a revision as the audit trail for what reaches models, so a
            // local checkout must actually be that revision, clean — otherwise it stamps content the
            // revision does not contain.
            const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
            let head;
            try {
                head = git(['rev-parse', 'HEAD']);
            } catch {
                throw new Error(`${root} is not a git checkout; sync from GitHub without --source`);
            }
            if (!head.startsWith(ref) && ref !== head) {
                throw new Error(`${root} is at ${head}, not the pinned ${ref}`);
            }
            const dirty = git(['status', '--porcelain']);
            if (dirty !== '') throw new Error(`${root} has uncommitted changes; commit or discard them first`);
            return head;
        },
    };
}

/** GitHub API source: one tree listing, then one raw fetch per markdown file. */
function githubSource(ref) {
    const api = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${ref}?recursive=1`;
    let resolved;
    return {
        listMarkdownFiles: async () => {
            const response = await fetch(api, { headers: { accept: 'application/vnd.github+json' } });
            if (!response.ok) throw new Error(`tree listing failed (${response.status}) for ${api}`);
            const body = await response.json();
            if (body.truncated) {
                throw new Error('the tree listing came back truncated; the catalog would silently miss files');
            }
            // Record the SHA the listing actually resolved, so a mutable --ref (a branch) can never
            // be stamped as the pin, and a push mid-sync cannot straddle two revisions.
            resolved = body.sha;
            return body.tree
                .filter((entry) => entry.type === 'blob' && entry.path.endsWith(INCLUDED_EXTENSION))
                .map((entry) => entry.path);
        },
        readText: async (path) => {
            const url = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${resolved}/${path}`;
            const response = await fetch(url);
            if (!response.ok) throw new Error(`fetch failed (${response.status}) for ${url}`);
            return response.text();
        },
        resolvedRevision: async () => resolved,
    };
}

/** Reads `name` from SKILL.md frontmatter without a YAML dependency. */
function frontmatterName(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!match) return undefined;
    const name = /^name:\s*(.+)\s*$/m.exec(match[1])?.[1];
    return name?.replace(/^['"]|['"]$/g, '');
}

async function main() {
    const options = parseArgs();
    const source = options.source ? localSource(options.source, options.ref) : githubSource(options.ref);
    const paths = (await source.listMarkdownFiles()).sort();
    if (paths.length === 0) throw new Error('no markdown files found upstream; refusing to write an empty catalog');

    // A skill is a top-level directory holding a SKILL.md; everything else upstream (repo README,
    // scripts, manifests) is catalog plumbing, not skill guidance, and stays out.
    const skillNames = new Set(paths.filter((path) => /^[^/]+\/SKILL\.md$/.test(path)).map((path) => path.split('/')[0]));
    if (skillNames.size === 0) throw new Error('no <skill>/SKILL.md found upstream; refusing to write an empty catalog');
    const files = [];
    const excluded = [];
    for (const path of paths) {
        if (!skillNames.has(path.split('/')[0])) continue;
        const withinSkill = path.slice(path.indexOf('/') + 1);
        if (!INCLUDED_WITHIN_SKILL.some((pattern) => pattern.test(withinSkill))) {
            excluded.push(path);
            continue;
        }
        // The loader serves the path verbatim as a skill:// URI, and hosts resolve reads through URL
        // normalization; a path that does not survive that round trip would list but never read.
        if (new URL(`skill://${path}`).toString() !== `skill://${path}`) {
            throw new Error(`${path}: does not survive URI normalization and could not be read back`);
        }
        files.push({ path, text: await source.readText(path) });
    }
    for (const path of excluded) {
        stderr.write(`    excluded by the within-skill allowlist: ${path}\n`);
    }

    // The skill name is the directory, and Agent Skills requires the frontmatter to agree with it.
    // A mismatch would build skill:// URIs that disagree with their own content, so it stops the sync.
    for (const { path, text } of files) {
        const name = path.split('/')[0];
        if (path === `${name}/SKILL.md`) {
            const declared = frontmatterName(text);
            if (declared !== name) throw new Error(`${path}: frontmatter name ${declared ?? '(none)'} != ${name}`);
        }
    }

    // The stamped revision is what the source resolved (a full SHA), never the requested ref, so a
    // branch name cannot masquerade as a pin and the header stays an audit trail.
    const revision = await source.resolvedRevision();
    const generated = `// ABOUTME: The vendored Steel skill catalog, generated by scripts/sync-skills.mjs from
// ABOUTME: ${REPO_OWNER}/${REPO_NAME}@${revision}. Markdown guidance only; edit upstream, then re-run the sync.
export const SKILL_CATALOG_REF = ${JSON.stringify(revision)};

/** One markdown file of one skill, at its upstream-relative path. */
export interface CatalogFile {
    readonly path: string;
    readonly text: string;
}

export const SKILL_CATALOG: readonly CatalogFile[] = [
${files.map((file) => `    { path: ${JSON.stringify(file.path)}, text: ${JSON.stringify(file.text)} },`).join('\n')}
];
`;

    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, generated);
    stderr.write(`    catalog: ${files.length} files across ${skillNames.size} skills (${revision})\n`);
    stderr.write(`    wrote ${OUTPUT_PATH}\n`);
}

await main();
