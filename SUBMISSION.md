<!-- ABOUTME: The work remaining before this server can be submitted to Anthropic's MCPB Desktop
     Extensions directory, split into repository work and work that needs a human. -->

# MCPB Desktop Extensions submission

Target: Anthropic's featured-extensions directory for Claude on macOS and Windows. The submission is
a Google Form that requires a `.mcpb` file attachment, so nothing can be submitted until the bundle
exists.

Verified against `@anthropic-ai/mcpb@2.1.2` and manifest schema **v0.4** on 2026-08-04. Required
manifest fields are `name`, `version`, `description`, `author`, `server`; `server` requires `type`,
`entry_point` and `mcp_config.command`; each `user_config` entry requires `type`, `title` and
`description`.

Bundle facts below re-measured 2026-08-24 by a full `npm run pack:mcpb` on `2.0.0-rc.9`: the staged
server starts over JSON-RPC, reports its own version, and lists **16 tools** with a 900,000ms hard and
600,000ms inactivity default.

RESEARCH.md §8 covers the wider distribution plan. This file is only the Claude Desktop directory.

## Where we already comply

Recorded so review prep does not re-litigate it.

| Requirement | Status |
|---|---|
| Public GitHub repo, MIT licensed | `steel-dev/steel-mcp-server`, MIT |
| Built with Node.js | Node ≥20, ESM |
| Tool names ≤64 chars (policy 5C) | Longest is `steel_session_diagnostics`, 25 |
| `title` + `readOnlyHint`/`destructiveHint` on every tool (5E) | All 16, enforced by `tests/integration/tools.test.ts:104` |
| Graceful, specific errors (5A) | Named errors with recovery actions; RESEARCH.md §7 |
| Token frugality (5B) | `npm run budget` gate, screenshots cap inline PNGs at 4 MiB and retain attachment links, post-action snapshots off by default |
| No extraneous conversation data (1D) | Telemetry loads no exporter unless an `OTEL_*` var asks; `tests/unit/packaging.test.ts` guards it |
| No catch-all tool | Every tool is a narrow verb; RESEARCH.md:94 notes a catch-all is an outright rejection |

---

## Phase 1 — repository work

All in-repo, all testable, no external dependency. Ordered so each step builds on the last.

### 1.1 Fix the facts the repo currently states wrongly

Policy 2B requires descriptions to match actual functionality, and a reviewer reads the README first.

**Done 2026-08-04.** All three, with guards in `tests/unit/packaging.test.ts`:

- ~~README documented `vision` and `full` as aliases of `browse`~~ — both are now refused rather
  than aliased (`PROFILE_NAMES` is `scrape`, `browse`), and the README documents only those two.
- ~~README said "twelve tools"~~ — it says sixteen and lists every tool, including replay,
  `steel_session_handoff`, `steel_batch`, `steel_session_options`, and `steel_session_live_view`,
  noting that hosts hide the last via `_meta.ui.visibility: ['app']`. A test asserts the README
  mentions every entry in `TOOL_TABLE`.
- ~~`repository.url` and `bugs` pointed at `steel-dev/mcp-server` and 404ed~~ — both now name
  `steel-dev/steel-mcp-server`, asserted against the real remote.

### 1.2 Prune the dependency tree for a desktop bundle

**Done 2026-08-04, counts current at rc.9.** The bundle carries five dependency trees
(`@modelcontextprotocol/server`, `@opentelemetry/api`, `safe-regex2`, `ws`, `zod`) and installs
7 packages;
`@modelcontextprotocol/node`, `ioredis` and the OpenTelemetry exporter stack are all unreachable
from `stdio.ts` and never installed. `scripts/stage-mcpb-package.mjs` narrows the staged
`package.json` before `npm install` rather than deleting directories afterwards — measurements and
the reason in [NOTES.md §7](NOTES.md#7-the-mcpb-desktop-bundle).

`tests/unit/packaging.test.ts` now walks the import graph from `stdio.ts`, separating static edges
(which must ship) from dynamic ones (which need not), so a new import that would break the bundle
fails a test rather than a user's install.

Policy 5G: `ws` at 8.21.2, `@biomejs/biome` at 2.5.6. `ioredis` 6.0.0 remains a deliberate
non-upgrade — it is a major bump, affects only the hosted path, and is not in the bundle at all.

### 1.3 Write `manifest.json`

**Done 2026-08-04.** Schema v0.4, author `nibzard`, `steel_api_key` marked `required` and
`sensitive`, `steel_profile` optional. `mcpb validate` passes. Guarded by
`tests/unit/mcpb-manifest.test.ts`, and by an integration test that compares the manifest's tool list
against a live client's `tools/list` rather than against `TOOL_TABLE`.

One bug fell out of writing it: a host substitutes the empty string for an optional `user_config`
value the user left alone, and `STEEL_PROFILE=""` used to fail startup with `Unknown STEEL_PROFILE ""`.
Fixed in `src/core/config.ts`, with a test naming the MCPB reason.

### 1.4 Add the pack script

**Done 2026-08-04.** `npm run pack:mcpb` builds, stages, narrows, installs, verifies the staged
server over real JSON-RPC (`scripts/verify-mcpb-stage.mjs`), validates and packs. It runs in CI, so a
bundle that stops building fails a pull request.

The verify step is the load-bearing part: pruning a dependency too eagerly produces a bundle that
installs fine and dies on launch. Removing `ws` from a staged tree makes it exit 1 with
`MODULE_NOT_FOUND`, which is the whole point.

### 1.5 Add the missing developer-requirement docs

**Done 2026-08-04.** `SECURITY.md` with a disclosure contact and what the server treats as untrusted;
README gained Support and Privacy sections, a labelled Example prompts table with five worked cases,
a Claude-for-desktop install path, and three Desktop-specific troubleshooting entries. A test asserts
the README links the same privacy policy the manifest declares.

### 1.6 Install and exercise the bundle locally

The release-candidate bundle is packed at `build/steel-mcp-2.0.0-rc.9.mcpb` (2.0MB, 969 files) and
its staged server verified over JSON-RPC.
Installing it into Claude for macOS, running all 16 tools against a real Steel key, and confirming the
live viewer and finished-session replay render is **yours** — see 2.7.

Seven release candidates separate rc.2 from rc.9, and the manual run covers ground rc.2 did not have:
`steel_session_handoff` gained the trusted local-file picker and an exclusive renewable human-control
lease, `steel_session_options` joined the tool table as the sixteenth tool, a session refuses a
profile the caller did not choose, and an unstable or no-op click hands off rather than guessing.

---

## Phase 2 — needs you

Ordered by lead time. **2.1, 2.2 and 2.5 are settled** — recorded here so the decisions are not
re-litigated. The rest block submission.

### 2.1 The `author` field — settled

`{ name: "Steel", email: "niko@steelbrowser.com", url: "https://github.com/steel-dev" }`. The work
is done for Steel, so the manifest credits the company and links its GitHub org; the email stays a
reachable Steel-domain contact. The form still asks for a personal GitHub profile — that answer
lives in the form itself (2.8), not in the manifest.

### 2.2 The release version — settled

`2.0.0-rc.9`. `package.json`, `SERVER_VERSION`, `manifest.json` and the README's Status line all say
so, and tests hold them together. Promote the same code to `2.0.0` after the release-candidate checks
pass.

### 2.3 Publish a real privacy policy

`https://steel.dev/privacy` **308-redirects to a Google Doc**
(`docs.google.com/document/d/1q3QBkFm4ke-…`). You judged this acceptable as-is, so the manifest and
README both link it and nothing here is blocked.

Still worth doing before review: RESEARCH.md §8 item 8 flags a missing policy as an immediate
rejection, and a Google Doc is the kind of thing a reviewer reads as unmaintained. If a real page
lands on `steel.dev`, the URL does not change and no repo work follows.

### 2.4 Provision the reviewer demo account — policy 3D

A dedicated Steel org: fully populated, **no MFA, no SMS, no email confirmation, no private-network
access**. Reviewers run every tool with these credentials. Spec already written in RESEARCH.md §8
item 9. Steel platform work.

### 2.5 Server icon — settled

`assets/icon.png`, 512×512, the Steel mark white on the brand's black field, rendered from
`assets/icon.svg` you supplied. `mcpb validate` accepts it and a test asserts the file the manifest
names exists.

### 2.6 Confirm the security contact and SLA

`SECURITY.md` directs reports to **niko@steelbrowser.com** and promises acknowledgement in three
working days, assessment in ten. Two things to confirm, because both are commitments I wrote on
Steel's behalf:

- Whether a `security@steel.dev` alias exists and should replace the personal address. I used the
  address you gave me rather than guessing at one that might bounce.
- Whether those response windows are ones Steel wants to be held to.

### 2.7 Install the bundle and run all 16 tools

`build/steel-mcp-2.0.0-rc.9.mcpb`. Its staged server is verified over JSON-RPC and lists 16 tools, but
that proves it starts, not that a real Steel key drives a real browser through Desktop's own Node.
Install it, fully restart Claude, and open a new conversation. Confirm the installed server reports
`2.0.0-rc.9`, lists 16 tools including `steel_session_handoff` and `steel_session_options`, and
defaults to a 15-minute hard deadline with a 10-minute inactivity timeout. Run each tool, confirm the
live viewer renders, and exercise Take control → Hand back → Continue on the same session. Also
exercise the trusted local-file picker during a handoff, and confirm the chosen file reaches the page
while its path and bytes stay off the model plane. Finished-session replay is dashboard-only in this
release candidate, so verify that its safe dashboard link opens and that no replay app resource is
registered or bundled.

### 2.8 Submit the form

Needs your Google account (`nikola.balic@gmail.com`), the packed `.mcpb`, and agreement to the MCP
Directory Terms. Draft answers below.

---

## Draft form answers

| Field | Answer |
|---|---|
| Is this an update to an existing extension? | No |
| Primary Contact Name | Nikola Balić |
| Primary Contact Email | niko@steelbrowser.com |
| GitHub Link | `https://github.com/steel-dev/steel-mcp-server` |
| Primary Party Confirmation | **Yes** — you work for Steel, which owns the service |
| MCP Server Description (50 words max) | Draft: "Gives Claude a real Chrome browser in the cloud via Steel. Reads pages that block plain fetch as markdown, captures screenshots and PDFs, and drives interactive sites — clicking, typing, filling forms, working through logins — using accessibility-tree references rather than pixel coordinates." (44 words) |

---

## Explicitly not blocking

- **MCP Apps session viewer** — the inline viewer is a differentiator, not a requirement. Whether
  Claude Desktop honours `_meta.ui.visibility` from an MCPB install is worth confirming in 1.6, but
  a "no" costs us a hidden tool becoming visible, not a rejection.
- **OAuth / `mcp.steel.dev`** — the Connectors Directory needs it (RESEARCH.md §8 item 20). The MCPB
  directory does not. This is the OAuth-free route, which is why it goes first.
