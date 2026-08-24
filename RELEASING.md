<!-- ABOUTME: What this one package ships, how the four artifacts are built from it, and the steps to
     ABOUTME: cut a release. Read this before tagging anything. -->

# Releasing

This is **one npm package with several entrypoints**, not a monorepo. One transport-independent core
under `src/core/`, and thin entrypoints that adapt it to a transport. There are no workspaces and
there should not be: the core is shared by construction, so splitting it would buy version skew
between packages in exchange for nothing.

## What ships, and from what

| Artifact | Built from | For | Published by |
|---|---|---|---|
| **MCPB bundle** `steel-mcp-<version>.mcpb` | `dist/stdio.js` | Claude for macOS and Windows | `release.yml`, attached to the GitHub release |
| **npm package** `steel-mcp` | `bin` → `dist/stdio.js`, plus `exports` for embedding | `npx`, CLI hosts, anyone importing the core | Not published by the release-candidate workflow |
| **Container image** | `dist/stdio.js` by default, `docker run <image> dist/hosted.js` for the HTTP endpoint | Self-hosters | Built as a gate; not published by the release-candidate workflow |
| **`mcp.steel.dev`** | `dist/hosted.js` | Steel's own hosted service | Not wired up here; deployed from the image |

The entrypoints, since three of them have similar names:

| File | What it is |
|---|---|
| `src/stdio.ts` | The local server. One process, one credential, in-memory handles |
| `src/http.ts` | The hosted **boundary**: routing, DNS-rebinding guards, credential extraction. Not runnable |
| `src/hosted-runtime.ts` | The hosted **shared runtime**: Steel client reuse per credential, tenant isolation, handle store choice. Not runnable |
| `src/hosted.ts` | The runnable hosted server. Composes the two above onto Node's HTTP server |

## Dependencies are split on purpose

`dependencies` holds only what `dist/stdio.js` imports — five packages
(`@modelcontextprotocol/server`, `@opentelemetry/api`, `safe-regex2`, `ws`, `zod`). Everything the
hosted path needs is an **optional `peerDependency`**, so it is absent from a default install:

| Package | Needed by | Why it is not a dependency |
|---|---|---|
| `ioredis` | `hosted-runtime.ts`, for the shared handle store | 1.1M plus six transitive packages |
| `@modelcontextprotocol/node` | `hosted.ts` | Pulls `hono`, 2.7M |
| `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http` | `tracing.ts`, only when an `OTEL_*` variable asks | 35M. Loaded through a dynamic `import()` in a `try`/`catch` that warns and carries on, so absent is a supported state |

Measured 2026-08-04: with those in `dependencies` and `optionalDependencies`, a consumer install was
**68M across 85 packages**. Re-measured 2026-08-24, it is **17M across 7 packages** — the same tree the
MCPB bundle carries. npm installs `optionalDependencies` by default, which is why the exporter stack
reached everyone; only `peerDependenciesMeta.<name>.optional` actually keeps a package out of a
default install.

All four hosted-only peers are also in `devDependencies`, so this repository builds, typechecks and
tests against them.
The dashboard-only release-candidate replay path has no Hls.js dependency or staged player asset.
Consequences to remember:

- **A self-hoster running `dist/hosted.js` must install them.** The README's hosted section says so.
- **The container image installs them itself**, after `npm prune --omit=dev` removes them. It reads
  the versions out of `peerDependencies` so the two cannot drift.
- **`tests/unit/packaging.test.ts` walks the import graph from `stdio.ts`** and fails if a new static
  import would make the bundle need something it does not carry.

## The version lives in package.json

Four files state it: `package.json`, `src/core/version.ts`, `manifest.json`, and the README's Status
line. `scripts/sync-version.mjs` writes the other three from `package.json`, and npm's `version`
lifecycle hook runs it, so a bump is one command and lands in one commit.

`src/core/version.ts` is generated but checked in, because the server reports its version without
reading a file at startup.

```bash
npm run sync:version            # write the other three from package.json
npm run sync:version -- --check # fail if any disagree; this is what CI runs
```

Tests assert all four agree, so drift fails a pull request rather than a release.

## Lockfile and install policy

`package-lock.json` is committed. Dependency changes must update it. Local development may use
`npm install`, while clean CI, release verification and the Docker builder use `npm ci` against that
tracked graph. MCPB staging is the deliberate exception: its generated package manifest is narrower
than the root manifest, so `scripts/pack-mcpb.sh` uses `npm install` inside the staging directory.

## Cutting a release

```bash
# 1. On a clean tree, with the checks passing.
npm run typecheck && npm run lint && npm test && npm run budget && npm run conformance

# 2. Bump on a normal reviewed branch. This rewrites the other version surfaces.
npm version --no-git-tag-version patch     # or minor / major / 2.1.0

# 3. Merge the reviewed commit to main, then manually dispatch release.yml for that exact SHA.
```

The manually dispatched `release.yml`:

1. Runs every automated gate from the exact `main` SHA and packs the MCPB once.
2. Uploads that MCPB with `SHA256SUMS`, then pauses at the protected `release` environment so an
   operator can install and smoke those exact bytes in Claude Desktop.
3. After approval, downloads and verifies the same artifact, creates an annotated immutable tag at
   the recorded SHA, and publishes the GitHub release. A version with a prerelease suffix (`-rc.N`)
   is marked prerelease and not Latest; a bare version (`2.0.0`) publishes as a full release and
   becomes Latest. It never rebuilds in the publish job.
4. Does not publish npm or GHCR. Those require a separate ownership and distribution decision.

Configure the GitHub `release` environment with a required reviewer before dispatching the workflow.
Never approve the publish job until the downloaded candidate checksum and Desktop smoke pass.
The candidate artifact is retained for seven days, so approve within that window. If it expires
while approval is pending, rerun the workflow to build and smoke a new candidate; never substitute a
local MCPB or publish without redoing the checksum and Desktop gates.

### When package.json already states the version you want to release

`npm version <current-version>` fails with `Version not changed` when `package.json` already has that
value, so the flow above cannot produce that tag. The release candidate may already have been set
during preparation rather than by running the version lifecycle.

Do not tag it locally. Confirm the version surfaces and dispatch the protected workflow after merge:

```bash
npm run sync:version -- --check   # the generated version surfaces agree
```

The protected publish job creates `v<current-version>` only after approval; a suffixed version is
marked prerelease and not Latest, a bare one becomes the Latest release. If anything is wrong after
publication, prepare the next release; never move an existing tag.

## Before the first release

- [ ] Protect the GitHub `release` environment with a required reviewer.
- [ ] Decide npm and GHCR ownership and prerelease tagging separately; this workflow publishes neither.
- [ ] The MCPB directory submission has its own checklist in [SUBMISSION.md](SUBMISSION.md).
- [ ] The registry record, the DNS verification ticket, and the rest of distribution are in
      [RESEARCH.md §8](RESEARCH.md#8-distribution-checklist).
