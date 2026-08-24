# Steel MCP Server v2 — Implementation Plan

**Status:** P0–P2 and P4.5 complete; P3 in progress
**Branch:** `niko/steel-mcp-server-v2`
**Supersedes:** the v1 Puppeteer/Web-Voyager server on `main` (`src/index.ts`, MCP SDK 1.0.1, last touched Feb 2025)
**Evidence base:** `RESEARCH.md` in this directory — 7 research tracks, 4 adversarially fact-checked, 2026-07-27. Read it for the *why* behind any decision here.

**Implementation checkpoint (2026-08-13):** stdio, the sixteen-tool core, real-browser E2E and
legacy/2026-07-28 conformance gates are passing. P2 has a web-standard `/mcp` boundary with
request-scoped credentials, bearer-over-query precedence, credential redaction, and Host/Origin
validation, over a hosted runtime that shares handles across requests, isolates REST/CDP clients by
credential, and reclaims a session whose create request disconnects — with a Redis-backed handle
registry (`REDIS_URL`), per-principal cost-weighted rate limiting, OpenTelemetry with `_meta` trace
propagation (`steel-mcp/tracing`), and the MRTR human-in-the-loop handoff.

P4.5 landed ahead of P3 and past its original scope: MCP Apps now show a controllable live CDP
screencast with exclusive renewable human-control leases, release fencing, and a trusted local-file
picker whose bytes stay off the MCP/model plane, plus a safe dashboard link for a finished headed
session. `steel_session_handoff` invokes the same MRTR path for any manual step; login walls and
CAPTCHAs still invoke it automatically (§14.A).

P3 now has its entrypoint: `src/hosted.ts` (`npm run start:hosted`) builds the runtime, picks the
handle store from the environment, serves `/mcp` over Node's HTTP server with a `/healthz` probe
ahead of the Host allowlist, and releases every session it holds on shutdown. A single-replica
deployment behind a Coolify/Traefik proxy serves it to a real client (NOTES §9). What remains in P3
is operational rather than structural: leak-path metrics and alerting on the Steel-backstop release
count (§5), a soak test, and `mcp.steel.dev` itself.

**Checks re-run 2026-08-24 on `2.0.0-rc.9`:** typecheck, lint, 949 unit and integration tests, the
byte budgets (browse: 16 tools, 16,691 of 17,000 bytes; instructions exactly at the 2,048-byte cap),
and conformance at both protocol eras all pass. `npm run pack:mcpb` produces a bundle whose staged
server lists 16 tools over real JSON-RPC. The real-browser suites (`test:browser`, `test:e2e`) need
local Chrome and Docker and were not part of that run.

---

## 1. Goals

1. **One canonical Steel MCP server** serving every MCP host — Claude Code/Desktop, Cursor, VS Code, Goose, ChatGPT connectors, custom agents, CI pipelines — from one core.
2. **Hosted-first**: a multi-tenant Streamable-HTTP endpoint at `https://mcp.steel.dev/mcp`. Zero install, tool improvements ship continuously.
3. **Same core over stdio**: for MCPB bundles, `npx` users, self-hosters running the steel-browser Docker image, CI pipelines, and every host that spawns subprocesses. Also the cheapest way to test the core.
4. **Token-cheap by construction, and provably so.** Markdown scrape as the primary read; accessibility snapshots for interaction; screenshots as resource links. We publish measured numbers — nobody in this category does.
5. **Never leak a billed browser session**, guaranteed server-side rather than by client cooperation.

## 2. Non-goals

- Not an agent. No LLM inference inside the product — no `run_task(natural_language)`. The host's model decides *when*; we execute *how*, deterministically and reproducibly.
- No bundled Chromium. The browser is always a Steel session (cloud or self-hosted).
- No feature parity with v1. The Web-Voyager numbered-screenshot loop is replaced, not ported.
- No single-consumer special-casing. Every design choice must earn its place for the general Steel user.

## 3. Protocol and dependency targets

| Thing | Target | Notes |
|---|---|---|
| MCP spec | **2026-07-28** primary | Shipped final 2026-07-28 (RC locked 2026-05-21). Largest revision since launch. 2025-11-25 and 2025-06-18 served via the SDK legacy shim |
| SDK | `@modelcontextprotocol/server@2.0.0` + `@modelcontextprotocol/node` | v2 went **stable 2.0.0 on 2026-07-27**; the `beta` dist-tag is gone. It is the only line implementing the new wire format. The v1 line still gets maintenance (1.30.0 shipped 2026-07-27) but is frozen at the legacy protocol — do not build on it. Pins are exact |
| Runtime | **Node ≥20, Zod ≥4.2, `"type": "module"`** | ESM-first with a CJS build available. Painful to retrofit — commit at P0 |
| Steel access | `steel-sdk@^0.18` **plus a thin typed REST layer** | SDK published 2026-03-16, missing `inactivityTimeout`, `browserMode`, `caCertificates`, and the `/agent-traces`, `/logs`, `/hls`, `/v1/projects` endpoint families |
| Conformance | `@modelcontextprotocol/conformance` | Replaces hand-rolled protocol tests; the same harness Tier-1 SDKs are measured against |

**Spec changes that shape this design** (full list in RESEARCH.md §2.1): protocol sessions, `Mcp-Session-Id`, and the `initialize` handshake are removed (SEP-2567/2575); `GET`/`DELETE` on the MCP endpoint answer `405`; SSE resumability and `Last-Event-ID` are gone; `server/discover` is a new MUST; every POST carries `MCP-Protocol-Version` (plus `Mcp-Method`/`Mcp-Name` on calls); results carry required `resultType`, and list results require `ttlMs` + `cacheScope`; Roots, Sampling and Logging are deprecated; Tasks moved out of core into the `io.modelcontextprotocol/tasks` extension (SEP-2663).

> **Verified 2026-07-30.** The spec shipped final on 2026-07-28: `/specification/2026-07-28` and its changelog are live, and Anthropic announced Claude support the same day. One post-RC change to absorb: the new error codes were renumbered into a reserved MCP range (`HeaderMismatch` -32001 → **-32020**, `MissingRequiredClientCapability` -32003 → **-32021**, `UnsupportedProtocolVersion` -32004 → **-32022**). `@modelcontextprotocol/server@2.0.0` ships the final numbering, and our conformance gate passes at both eras against it — nothing in this repo needed to change.

## 4. Architecture

```
 MCP host (Claude Code / Cursor / VS Code / Goose / ChatGPT / CI)
   │  Streamable HTTP: POST /mcp     (GET, DELETE -> 405)
   │  Authorization: Bearer <STEEL_API_KEY>   or  ?apiKey=  fallback
   ▼
 mcp.steel.dev — stateless Node replicas, round-robin, no sticky routing
   ├─ Auth: key -> project within org, plan limits from GET /v1/details
   ├─ Handle registry (Redis): session_id -> {steel_session_id, org, project, timestamps}
   ├─ Tool layer (transport-agnostic core)
   │    ├─ stateless reads ──► POST /v1/scrape | /v1/screenshot | /v1/pdf
   │    ├─ structured browse ──► CDP  wss://connect.steel.dev?apiKey=<key>&sessionId=<id>
   │    └─ vision profile ──► POST /v1/sessions/{id}/computer
   └─ Reaper: sweeps orphaned handles -> POST /v1/sessions/{id}/release
```

**Package shape** — one repo, three entrypoints, one core:

```
src/
  core/
    tools/           # scrape, screenshot, pdf, session, navigate, snapshot, find, act, wait, diagnostics, batch
    profiles.ts      # scrape | browse | vision | full
    snapshot.ts      # a11y tree, @eN refs keyed on (loaderId, backendNodeId), versioned
    settle.ts        # WaitForHelper: frame-navigation + MutationObserver quiescence
    untrusted.ts     # provenance fencing, invisible-content stripping, password redaction
    registry.ts      # handle registry + reaper
    steel/           # typed REST layer over /v1 + CDP client
    errors.ts        # Steel failure -> actionable tool-execution error
    apps/            # the MCP-App session viewer shell (§14.A)
  http.ts            # Streamable HTTP boundary: routing, DNS-rebinding guards, credentials
  hosted-runtime.ts  # shared per-credential clients, handle store selection
  hosted.ts          # hosted entrypoint: binds a port, serves /mcp and /healthz
  stdio.ts           # stdio entrypoint (bin: steel-mcp)
```

**Dependency-injection shape:** module-scope pools, clients and registry, closed over by a **per-request server factory** — `createMcpHandler` runs its factory once per HTTP request. This is not the long-lived `buildServer(deps)` singleton an earlier draft assumed.

**A third entrypoint to decide on:** both Microsoft and Google hedged their browser MCP servers with a CLI + skills within four months of each other, on token grounds. Steel already ships a Rust CLI and five skills. Either wire them to this core or write down why not — shipping two divergent implementations of the same semantics is the failure mode.

## 5. State model — explicit handles

There is no protocol session to hang state on. `steel_session_create` mints a handle; every stateful tool takes `session_id` as an ordinary argument. This is the spec's prescribed replacement, and its worked example is literally an open browser context.

Consequences, all good: no Redis event store, no sticky routing, no `Mcp-Session-Id`, replicas fully interchangeable, and **multiple concurrent browsers per client** become possible (capped by plan concurrency, not by structure). It is also the only model that works on ChatGPT and claude.ai, which already close the MCP session between consecutive tool calls.

**Handles are not capabilities.** Namespace as `<org_id>:<handle>`, ≥128 bits of CSPRNG entropy, opaque `sess_` prefix, never derived from org id or timestamp. Re-authorize `(handle, org)` on **every single call** from that request's own credential — never from anything cached at creation. A leaked handle otherwise grants a stranger a live, possibly logged-in browser.

### Never leaking a billed session

Five layers. The strongest is not ours:

| # | Layer | Survives |
|---|---|---|
| 1 | **Steel `inactivityTimeout`** (~120s) set on every create | our process dying, replica rescheduling, network partition, client vanishing. **This is the guarantee** |
| 2 | **Steel `timeout`** hard cap. Requested as 15 minutes by default and clamped only when `GET /v1/details` reports a maximum. When it does not, Steel validates the requested value; the configured default is not misreported as a plan ceiling | same |
| 3 | **Client-minted `sessionId` UUID** passed on create | the create-then-crash gap: we know the id before create returns |
| 4 | **`steel_session_release`** tool, idempotent, retention policy stated in `steel_session_create`'s description so the model can see the cost | fast path |
| 5 | **Abort on stream close** — plumb the request abort signal into every CDP call | closing the SSE stream *is* cancellation now; `notifications/cancelled` survives only on stdio. A client hang-up mid-navigate otherwise burns minutes with nobody listening |
| 6 | **Our reaper** over the handle registry | reclaims concurrency slots faster than Steel's timeout would |

Instrument a counter per release path and alert on the Steel-backstop count — that is the leak metric. Publish it as an SLO: a local MCP server structurally cannot offer this.

**Framing note:** a fully leaked 15-minute Launch session costs $0.025. The scarce resource is the **10-concurrent-session cap and the 20 RPM Browser Tools limit**, not dollars. Frame the reaper as slot reclamation.

## 6. Auth

| Tier | Mechanism | Reaches |
|---|---|---|
| **A — ships now** | `Authorization: Bearer <STEEL_API_KEY>`, with a `?apiKey=` query-param fallback (precedence: header → query → OAuth) | Claude Code, Cursor, VS Code, Zed, Goose, CI, the Official MCP Registry, Cursor Marketplace |
| **A — self-host** | No-auth mode, localhost-bound, Origin+Host validated | steel-browser Docker users |
| **B — later** | OAuth 2.1 resource server: **Client ID Metadata Documents, not DCR** (RFC 7591 DCR is deprecated), RFC 9728 metadata, RFC 8707 audience binding, RFC 9207 `iss`, S256 PKCE | Anthropic Connectors Directory, OpenAI Plugins Directory |

The query param is not optional politeness — Browserbase, Bright Data and Browserless all ship it because many hosts still cannot set headers. Issue **scoped, revocable MCP-specific keys** for it so a leaked URL is cheap to rotate, and redact in every log line.

**OAuth deferral is a distribution decision, not a technical one.** Tier A covers the developer surfaces; it does not reach the two largest consumer directories. Say so out loud when sequencing.

## 7. Tool surface

**Position: low-level primitives plus batching.** Not natural-language actions. The only measured evidence for the high-level architecture attributes its win to round-trip elimination, which `steel_batch` captures without putting an LLM in the product — and without the inference cost, nondeterminism, and hidden failure modes.

**Position: ship a vision surface, opt-in, never default.** Computer use is a native interleavable tool in 2026 frontier models, so a host can hold both surfaces at once and we don't have to choose. Back it with Steel's `POST /v1/sessions/{id}/computer`, downscale server-side at 1280×720, include `zoom(region)`. No coordinate grids or tiled images — measured no consistent uplift.

### Default `browse` profile

All tools `openWorldHint: true`, all carry `title` and `readOnlyHint`/`destructiveHint` (an Anthropic review requirement).

| Tool | Returns | Why it earns its slot |
|---|---|---|
| `steel_scrape` | fenced content + always-present `links[]` + `metadata`, cursor-paginated | **Primary read.** No session, no billing, no leak risk. Param is `format` (array-valued, singular name); values `html`\|`readability`\|`cleaned_html`\|`markdown` |
| `steel_screenshot` | **4 MiB-bounded MCP image block** when possible, always with an attachment resource link | "Screenshot causes context overflow by default" is a real filed issue against Playwright MCP. Don't repeat it |
| `steel_pdf` | resource link | `/v1/screenshot` and `/v1/pdf` return `{url}`, not bytes |
| `steel_session_create` | `{session_id, viewer_url, expires_at, plan_limits}` | **Explicit, not lazy** — the model must see that a billed resource started, name it, and release it |
| `steel_session_release` | confirmation + captured session context | Captures context *before* release so the ordering trap can't bite |
| `steel_navigate` | final URL, title, status, `navigated`, `dom_changed` | `include_snapshot` **false** by default |
| `steel_snapshot` | a11y tree with `@eN` refs + `snapshot_id` | The core structured read. Budget knobs mandatory |
| `steel_find` | matching nodes + refs + context | **Highest-ROI tool in the category.** Most turns need one element, not the page |
| `steel_act` | outcome + change signal | One action enum (`click`\|`type`\|`fill_form`\|`select`\|`hover`\|`scroll`\|`press`\|`go_back`\|`dismiss_overlays`). `target` accepts a ref **or** a selector — agents guess selectors constantly |
| `steel_wait_for` | outcome | Explicit waits only. **No `networkidle`** |
| `steel_session_diagnostics` | timeline from `/agent-traces` + `/logs` | **P1, not polish.** Nobody else can build this |
| `steel_session_replay` | safe Steel dashboard link | Explicit watch/replay request only; finished session by Steel UUID, or latest released; never starts a browser |
| `steel_batch` | one snapshot at the end, stops at first failure | Where the round-trip win lives |
| `steel_session_live_view` | scoped CDP connection details, no page content | Shipped with §14.A. `_meta.ui.visibility: ['app']`, so a supporting host keeps it out of the model's list; last in the tool table so every other tool's bytes stay identical |

Plus a **server `instructions` string** (≤2KB) as a reviewed deliverable. Claude Code enables MCP tool search by default, which makes this the primary discovery surface. Write it in the user's language — JS-rendered pages, sites that block plain fetch, login-gated content, CAPTCHAs, multi-step forms — not Steel's architecture.

### Profiles

Named presets, selected by credential or URL (`tools/list` must not vary per-connection, though it may vary by authorization):

`scrape` (3 stateless tools, zero billing) · **`browse`** (default, the 14 above) · `vision` (+ coordinate tools) · `full` (+ `steel_execute_js`, self-host/stdio only)

Design profiles at P0 when it's free, not later when it's breaking.

**Only `scrape` and `browse` are selectable.** The mechanism carries a profile list per tool, so
adding either of the other two is a data change — but neither has a tool of its own yet, and a name
a caller can select has to differ from the one next to it. `STEEL_PROFILE=vision` was accepted and
served the `browse` surface until 2026-08-04; it is now refused, and `PROFILE_NAMES` will grow again
when the tools do.

### Deliberately not shipping

`run_task(natural_language)` (violates the non-goal) · `steel_search` (**cloud has no `/v1/search`** — OSS-only, so it would break on cloud) · `steel_execute_js` in the hosted default (`full` profile only) · credential-management tools (routing secrets through model context defeats the feature; `steel_session_options` exposes only safe metadata and activates a namespace) · extension management · model-visible local paths or file bytes (the trusted viewer owns local file selection) · tab management (avoids per-target attach memory exhaustion) · **any catch-all `steel_request(method, path)`** — Anthropic's most-documented rejection reason · separate proxies/captcha/region/profile CRUD tools (advanced session setup stays in one deterministic planner).

## 8. Page representation and token economics

**A11y snapshot for interaction, markdown for reads, screenshots as links.** Playwright's own docs: 200–400 tokens versus 3,000–5,000. Anthropic's number for a computer-use screenshot is 1,000–1,800 input tokens plus ~500 of system overhead — so the honest ratio is 4–9×, which makes vision affordable as a per-step *escalation* and wrong as a default.

**Element refs** (this closes the old open question on ref stability):
- Key on **`(loaderId, backendNodeId)`** — Chrome DevTools MCP's model. Playwright invalidates when the ARIA role *or accessible name* changes, so a button whose label flips `Save` → `Saving…` silently gets a new ref mid-flow.
- Assign refs **only to nodes that are visible and receive pointer events** — non-interactable nodes appear in the text with no ref, so the model structurally cannot target them.
- Keep off-screen and hidden nodes *in the text* (whole-page comprehension is the advantage over screenshots); mark in-viewport status.
- **Version every ref** as `(snapshot_id, ref)` and return a precise staleness error naming the reason and the recovery action. Everyone else handles staleness with "re-snapshot and hope."
- Use the **`@eN` vocabulary** — Steel's CLI and all five installed skills already teach it. A second incompatible idiom means neither gets good.
- Synthesize names for unnamed nodes and flag them inferred: per WebAIM 2026, 30–46% of buttons and links have no accessible name.

**Context discipline:**
- Post-action snapshots **off** by default; return a one-line outcome plus a change signal.
- Every text tool budgeted well under the 25,000-token host cap, with a cursor.
- Reference-over-value via **resource links + short-lived signed CDN URLs** (competitors write to the client's disk; a hosted endpoint cannot). Pair with a `preview: <N chars>` so it isn't blind.
- **Auto-settle after every action** (frame-navigation watch + MutationObserver quiescence, budgets scaled by a network multiplier since Steel runs through proxies). Without it agents defensively call `wait_for` after everything.
- **Never return a bare "success"** from an interaction. If a click produced no navigation, no mutation and no focus change, say so — silent input loss makes the model conclude the app is broken.
- CI assertions on **both** `tools/list` bytes and reference-page snapshot bytes. Nobody measures response bytes, which is where the real cost is.

## 9. Security

Full threat table in RESEARCH.md §7. The load-bearing items:

**Prompt injection via page content is our worst threat and has no protocol answer.** The spec's security page doesn't mention it; five competing SEPs are still in review; Google measured a 32% relative increase in malicious injected content between Nov 2025 and Feb 2026. Our mitigations: strip zero-width characters, hidden nodes and HTML comments before the snapshot leaves the server; fence all page-derived text with a provenance header (final URL after redirects, fetch timestamp) and an explicit data-not-instructions statement; repeat that standing instruction in `instructions`; never echo page content into tool *descriptions*; never render it into a markdown image or link; optional `allowed_origins`. Document the residual risk plainly — this reduces, it does not eliminate.

This is also the clearest differentiator available. Both category leaders explicitly disclaim injection safety, and third parties are publicly security-grading MCP servers. We will be scanned the week we ship.

**Also mandatory:** per-call handle re-authorization (§5); `cacheScope: 'private'` on every result derived from an authenticated principal (the required new `ttlMs`/`cacheScope` fields are a spec-mandated footgun — this is exactly the Asana cross-tenant cache incident); redact `input[type=password]` from snapshots; Origin and Host validation in middleware (the SDK handler validates nothing).

**Human-in-the-loop as a feature, not just a mitigation.** On a login wall or CAPTCHA, return `resultType: "input_required"` with an elicit-URL pointing at Steel's interactive live viewer. The client retries with a new request id. This is arguably the highest-value thing a browser MCP server can do that a scraper API cannot — schedule it at P2/P3, not as polish.

**Error content is where the value lives.** Picking the mechanism (tool-execution errors) without specifying content wastes Steel's biggest existing asset: five skills encoding a bot-detection/proxy/auth taxonomy, standardized `{message, error, linkToDocs}` errors, and agent traces. Concretely: translate `402` into the verified-balance requirement for managed proxies; say *which* limit a `429` hit; recognize Cloudflare/DataDome/PerimeterX markers and name the mitigation ladder rung (identity → pacing → proxies → CAPTCHA → stealth, never all at once); name the covering element on a blocked click; give self-host capability gaps named errors (**self-hosted Steel is concurrency 1**).

## 10. Testing

TDD throughout, red → green → refactor. Test output pristine.

| Layer | What |
|---|---|
| Unit | Every tool handler; handle-registry state machine (create, reaper ordering, double-release idempotency); snapshot ref stability across DOM mutation; untrusted-content stripping; error mapping. Injected fake Steel client |
| Conformance | `@modelcontextprotocol/conformance --include-stateless-checks` at **both protocol eras**, replacing hand-rolled protocol assertions |
| Integration | Real SDK client ↔ our server over HTTP and stdio: `server/discover`, header-vs-body mismatch → `400`/`-32020`, **two-replica no-sticky-routing**, **cross-org handle rejection**, **abort-on-stream-close releases the Steel session**, header survives on `tools/call` (not just connect) |
| E2E | Docker-composed steel-browser + server + an **adversarial** fixture site: cookie banner, mid-task modal, infinite scroll, login wall, 429 with `Retry-After`, unnamed buttons. Plus a leak test: kill the client mid-session, assert release |
| Budget | CI fails on `tools/list` byte regression per profile and on reference-page snapshot regression |
| Agentic eval | Wire the server into Steel's own leaderboard harness. No browser MCP server publishes a reproducible success rate; Steel already owns the infrastructure |

## 11. Delivery phases

Distribution prerequisites with external queue time start **in parallel with P1**, not after P3.

- **P0 — Scaffold** (day 1). New `src/` layout, `@modelcontextprotocol/server@2` beta, Node 20 / ESM / Zod 4.2, Vitest, CI with conformance + byte budgets. Profiles designed in now. This plan and RESEARCH.md merged.
- **P1 — Core over stdio** (week 1). The §7 surface against local steel-browser. Snapshot pipeline measured against a hostile-site corpus — this is the highest technical risk in the plan.
  - **In parallel (⏱ external lead time):** claim the registry namespace and npm name (registry names are immutable, no unpublish); add `mcpName` to package.json; file the DNS verification ticket; provision `mcp.steel.dev` (currently NXDOMAIN); start the Claude Team org and OpenAI identity verification; publish a privacy policy; build the MFA-free demo account; **fix the live PulseMCP listing that advertises a v1 install path for a package never published to npm.**
- **P2 — Streamable HTTP** (week 2). Transport, handle registry, reaper, bearer + query-param auth, Origin/Host validation, cost-weighted rate limiting, OpenTelemetry with `_meta` trace propagation. MRTR human-in-the-loop.
- **P3 — Hosted** (week 3). The entrypoint has landed (`src/hosted.ts`: `STEEL_ALLOWED_HOSTS`,
  `STEEL_ALLOWED_ORIGINS`, `PORT`, `HOST`, `/healthz`, shutdown release), and a single-replica
  deployment behind a Coolify/Traefik proxy serves `/mcp` to a real client (NOTES §9 records what a
  reverse proxy in front of it changes). Remaining: leak-path metrics and alerting on the
  Steel-backstop release count (§5), a soak test, then `mcp.steel.dev`.
- **P4 — Distribution.** Official Registry record (both `remotes[]` and `packages[]`; no OAuth needed, and it transitively feeds the GitHub registry → VS Code gallery), `mcp-publisher` wired into release CI, README to the Playwright MCP bar with one-click badges, **the published token-economics table**, self-hosted Claude plugin marketplace, MCPB bundle → Smithery + Claude Desktop, Cursor Marketplace.
- **P4.5 — MCP Apps live-session viewer. Shipped.** Scoped in §14.A, built ahead of P3 because it had no dependency on either. It is the distribution asset ("watch your agent browse, inline in the chat"), and it is where MRTR hands over on a login wall.
- **P5 — Gated on OAuth.** Anthropic Connectors Directory, OpenAI Plugins Directory. Then the Tasks extension when the SDK ships server-side support (§14.B), and masking-based injection defense.

**Worth doing early, cheaply:** document "Playwright MCP / chrome-devtools-mcp pointed at a Steel CDP URL" as a supported path. It costs a README section, covers the power-user surface we're deliberately not building, and hedges the snapshot-quality risk. And consider a **keyless, per-IP-rate-limited `scrape` profile** — those tools consume no session-minutes by construction, Firecrawl proved the funnel, and no browser-infra competitor offers it.

## 12. Naming and packaging

`@steel-dev/mcp-server` **was never published to npm** — there is no installed base, no breaking change, and no migration to manage. Recommend **`steel-mcp`** unscoped for `npx steel-mcp` ergonomics, registry namespace `dev.steel/mcp-server`. Ship an MCPB bundle (the OAuth-free route onto both Claude Desktop and Smithery) and a Docker image. Do **not** point header-less hosts at `mcp-remote` — it is unmaintained since 2026-02-05 and will not speak the new protocol; point them at our own stdio binary.

## 13. Open questions

| # | Question | Who answers |
|---|---|---|
| 2 | **Can Steel bill active-seconds-only, or snapshot-and-suspend an idle session?** | Steel platform/billing, **this week**. Kernel's Standby Mode charges zero while idle — structurally better than any reaper. If we can match it the whole leak risk class collapses; if not, they market it against us |
| 3 | Does Steel have an OAuth AS, and does it support CIMD? | Steel platform. Gates both consumer directories. Building DCR would be building a deprecated mechanism |
| 4 | Is Anthropic's `static_headers` beta available to us? | `mcp-review@anthropic.com`. The only non-OAuth path into Claude's connector infra, but org-admin-scoped |
| 5 | Is the reported Claude Code bug real — custom headers sent on connect but not forwarded on tool-call POSTs? | Reproduce. If real, header auth is fragile on our best host and the query-param fallback becomes load-bearing |
| 7 | **Is our a11y snapshot good enough that a host's model can drive it?** | Build and measure in P1 against a hostile corpus. **The highest technical risk here** — the entire "deterministic, no LLM" differentiation rests on it |
| 8 | Which `region` values are actually valid? | Three Steel sources disagree. Pass through as a string, let the API validate |
| 11 | **Does a Launch or Scale key get session/concurrency limits back from `GET /v1/details`?** | Steel platform, or a smoke run with a non-admin key. An admin key returns only `{"plan":"admin"}`; the MCP now treats the maximum as unknown and lets Steel validate the requested duration |
| 9 | Should `/v1/search` be promoted from the OSS image to Cloud? | Steel platform. Agents constantly want search; until then we can't offer it |
| 10 | What is `steel-computer` (private repo, "persistent computers for AI agents")? | Steel product. An adjacent surface this may need to accommodate |
| 13 | When does server-side support for the redesigned `io.modelcontextprotocol/tasks` extension ship in an official SDK? | Watch the SDK releases and the ext-tasks repo. Gates §14.B — SDK 2.0.0 carries only the legacy experimental task shim |
| 14 | **Can a session be created with a read-only or expiring player URL?** The `debugUrl` player is an unauthenticated bearer capability that is *interactive by default* (`debugConfig.interactive: true`), and `CreateSessionRequest` (src/core/steel/types.ts) exposes no field to turn that off — so a read-only viewer is not currently expressible through this repo's client | Steel platform. Still open, but no longer gating: the inline viewer uses a scoped CDP token instead, so `debugUrl` now only reaches a person MRTR is already handing the browser to (§14.A) |

### Resolved

| # | Question | Answer |
|---|---|---|
| 1 | Did 2026-07-28 ship final, unchanged from the RC? | **Yes, shipped 2026-07-28** — with one post-RC delta: error codes renumbered into the reserved `-32020`…`-32099` range (see §3 note). Verified 2026-07-30 |
| 6 | Does `@modelcontextprotocol/server@2` go stable and pass conformance at both eras? | **Yes** — 2.0.0 is the `latest` dist-tag, treats 2026-07-28 as its native protocol with the final error-code numbering, and our conformance gate passes 2 legacy + 5 modern scenarios against it. Verified 2026-07-30 |
| 12 | Can the Steel live viewer be embedded in an MCP-app iframe? | **Yes, unconditionally at the HTTP layer** — live probe 2026-07-30 (one Launch session, released, 0 credits). `debugUrl` (`api.steel.dev/v1/sessions/{id}/player`) is a self-contained WebRTC player *built* for embedding: no `X-Frame-Options`, no CSP on either Steel origin, documented `steel:*` postMessage events (`steel:ready`, `steel:autoplay-blocked`, …) and `hideOverlay`/`hideInteractionDialog` params. The app shell needs only `frame-src https://api.steel.dev`. **`sessionViewerUrl` is the wrong URL for embedding** — it is the login-walled dashboard SPA. Residual risks are host-side (autoplay policy, nested-sandbox flags) plus the new open question 14 |

## 14. Extension track — MCP Apps and Tasks

Both graduated to official extensions with 2026-07-28. Negotiation is uniform and per-request: the
client declares support under `extensions` in `_meta["io.modelcontextprotocol/clientCapabilities"]`;
the server advertises under `capabilities.extensions` in `server/discover`. Both are opt-in and
degrade gracefully — a non-supporting host sees exactly today's behavior. Facts verified 2026-07-30
against the extension specs and the installed SDK.

### 14.A MCP Apps (`io.modelcontextprotocol/ui`) — inline live session viewer

**What shipped:** `steel_session_create` declares `_meta.ui.resourceUri: "ui://steel/session-viewer"`.
The server registers that `ui://` resource: one static HTML shell (`text/html;profile=mcp-app`,
self-contained, no external scripts) that the host renders in a sandboxed iframe. The shell asks
`steel_session_live_view` for the session's scoped CDP token over the postMessage bridge, opens the
CDP socket itself, and paints `Page.screencastFrame` onto a canvas; input on that canvas is
forwarded back to the page over the same socket. It does **not** embed Steel's player: Claude allows
no third-party iframe at all (measured below), which is what killed the original embedding design.
The human watches — and on a login wall or CAPTCHA, *acts in* — the agent's browser without leaving
the conversation. This is the §9 human-in-the-loop feature with the last mile built in: MRTR
`input_required` points at a viewer that is already rendered inline.

**The host's actual policy, measured 2026-07-31.** A throwaway probe app rendered in Claude Desktop
(1.24012.9, Electron 42) reported the literal CSP Claude enforces on an MCP app, recovered from a
`securitypolicyviolation` event, together with a declared-vs-undeclared control pair:

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: https://assets.claude.ai;
style-src 'self' 'unsafe-inline' https://assets.claude.ai; img-src 'self' data: blob: https://assets.claude.ai;
connect-src 'self' <every connectDomains entry>; font-src 'self' https://assets.claude.ai;
media-src 'self' blob: data: https://assets.claude.ai; worker-src 'self' blob: https://assets.claude.ai;
frame-src 'self' blob: data:; base-uri 'self'; object-src 'none';
frame-ancestors 'self' https://claude.ai https://preview.claude.ai app://localhost; form-action 'self';
```

What that settles:

- **`connectDomains` IS honoured.** `https://api.steel.dev` answered 401 and `wss://connect.steel.dev`
  closed with 1006 — both proving the request left the page — while an undeclared `example.com` was
  blocked on `connect-src` with `disposition: enforce`. Real allowlist enforcement, not a wide-open
  policy: a live view can reach Steel from inside a Claude conversation.
- **`frame-src` is `'self' blob: data:`** with no third-party origin, consistent with Anthropic's
  documented `frameDomains` restriction. (The probe declared only `connectDomains`, so this is
  corroboration, not an independent test of `frameDomains`.)
- **`blob:` is allowed for `media-src`, `worker-src` and `script-src`, and `'unsafe-eval'` is
  permitted** — so frame decoding in a Worker and a `MediaSource` video path are both available
  alongside a canvas.
- The app runs on an auto-assigned `https://<32-hex>.claudemcpcontent.com` origin even from a local
  stdio server, and the postMessage bridge (`ui/initialize`, then an app-only `tools/call`) works
  end to end against host `Claude 1.0.0`.
- Untested by symmetry: `resourceDomains` presumably reaches `img-src`/`media-src` the same way
  `connectDomains` reaches `connect-src`, but nothing here measured it.

**Why it goes first:** everything it needs exists today. The SDK's capability schema carries
`extensions`; `@modelcontextprotocol/ext-apps` (1.7.5) provides the in-iframe `App` class; client
adoption is the broadest of any extension (Claude web/Desktop, ChatGPT, VS Code Copilot, M365
Copilot, Cursor, Goose, Postman, MCPJam — RESEARCH.md client matrix). No OAuth, no SDK gap, no new
protocol machinery.

**What shipped, and how it differs from the original design:**

1. **The iframe design died, and the CDP screencast replaced it.** The 2026-07-30 probe answered the
   *Steel* side (question 12): the player is embed-ready — no framing blocks on any Steel origin,
   `steel:*` postMessage lifecycle events, `hideOverlay`/`hideInteractionDialog` params. The
   2026-07-31 probe answered the *host* side, and that is where the design died: **Claude does not
   honour `frameDomains`.** It enforces a hardcoded `frame-src 'self' blob: data:`
   (anthropics/claude-ai-mcp #40 open, #54 *closed as not planned*), so a shell nesting
   `api.steel.dev` renders as an empty box. **An earlier revision of this item said "the
   CDP-screencast fallback is dead; do not build it" — that was wrong**, and painting screencast
   frames to a canvas is what the shipped viewer does.
2. `capabilities.extensions["io.modelcontextprotocol/ui"]` and `resources: {listChanged: false}` are
   declared; the shell is served at `ui://steel/session-viewer` with a per-resource
   `ttlMs` = 1h / `cacheScope: 'public'` hint that deliberately overrides the private
   `resources/read` hint next to it. No per-session data is baked in — the shell is byte-identical
   for every caller, and everything session-specific arrives over the bridge.
3. The shell is vanilla JS with no external script, and its `_meta.ui.csp` declares
   `connectDomains: [origin of config.connectUrl]` rather than a hardcoded Steel Cloud host, so a
   self-hosted deployment's shell can reach its own CDP endpoint. It opens CDP with the
   session-scoped token, paints `Page.screencastFrame` to a canvas, and — the one scope increase
   over "pure display in v1" — forwards mouse, keyboard and scroll input back through
   `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`, which is what makes the handoff
   in §9 finish inside the conversation.
4. `_meta.ui.resourceUri` is on `steel_session_create`; the text content is unchanged, so a host
   without the extension sees exactly what it saw before. The app gets its connection details from
   `steel_session_live_view`, an app-only tool (`visibility: ['app']`) that authorizes its handle
   like every other tool, because visibility is host-side list filtering and not a security
   boundary (NOTES §2).
5. Security: page-derived text never flows into the template, the app renders the *browser* rather
   than page text, and question 14 was answered by construction — **nothing hands out the player
   URL to the inline path**. The viewer reaches the browser over a session-scoped, self-expiring CDP
   token instead, and MRTR falls back to the player URL only for a client with no viewer rendered.
6. Tests: unit (resource registration, `_meta`, no dynamic interpolation), integration
   (`server/discover` advertises the extension, `resources/read` MIME and cache hints), budget (the
   `_meta.ui` bytes are priced — 16 tools, 16,691 bytes of the 17,000-byte budget), and
   `npm run test:browser`, which runs the shell in a real Chrome against a fake CDP server. That last
   suite exists because unit tests asserting the shell's *source* passed while two runtime bugs made
   it unusable (NOTES §6).

### 14.B Tasks (`io.modelcontextprotocol/tasks`) — durable handles for long operations

**What it would ship:** `steel_batch` returns `resultType: "task"` with a `taskId` when a run will
outlive host timeouts; the client polls `tasks/get`; a login wall mid-batch moves the task to
`input_required` carrying an elicitation the client answers via `tasks/update` — pointing the human
at the §14.A viewer. `tasks/cancel` maps to releasing the drive loop, never silently to releasing
the session.

**Gate, verified:** SDK 2.0.0 ships only the *legacy* experimental task plumbing (`tasks/result`,
`tasks/list` — kept for the 2025-11-25 shim). The redesigned extension (polling `tasks/get`, new
`tasks/update`, `tasks/list` removed) has no server-side SDK support and no published ext package.
Hand-rolling the wire format now means owning details the SDK will ship helpers for weeks later.
**Decision: stay gated on the SDK (open question 13); bank the design now.**

**Design decisions banked (cheap while waiting, expensive to retrofit):**

- **Task-capable tools:** `steel_batch` only. Single-action tools resolve inside any host timeout;
  a task handle would add a poll round-trip for nothing.
- **Spec MUST honored at the call site:** never return a task to a caller whose *current request*
  didn't declare the extension — checked per request like everything else in the stateless model,
  never cached from an earlier call.
- **Task ids are handles and inherit §5 verbatim:** `task_` prefix, ≥128-bit CSPRNG, namespaced by
  principal, re-authorized against the request's own credential on every `tasks/get`/`update`/
  `cancel`. A leaked task id must be worth nothing to a stranger.
- **Store behind the same seam as the handle registry:** in-memory for stdio, shared backend for
  hosted multi-replica — polls land on any replica. The task record carries the session handle so
  the reaper and task store cannot disagree about liveness.
- **TTL discipline:** a task must not outlive the browser it drives. `ttlMs` ≤ the session's
  remaining hard timeout; a task parked on `input_required` is deliberately *not* exempt from the
  session clock — the status message states the expiry so the cost of waiting is visible.
- **Budgets:** a completed task's `result` is a normal `steel_batch` result and obeys §8 budgets;
  polling responses stay tiny (status, message, `pollIntervalMs`).

**Estimate once the SDK ships:** ~1 week — task state machine + store with full unit coverage,
integration tests for cross-replica polling and cross-org rejection, and whatever tasks scenarios
the conformance suite grows (watch it alongside the SDK).

## 15. Known gaps carried out of the P2 review

Two adversarial reviews of the P2 landing (merge seams, and the MRTR security surface) found bugs
that were fixed on the spot and design questions that were not. The fixed ones are not listed here;
these are the deliberate deferrals, recorded so they are decisions rather than oversights.

| # | Gap | Why it was deferred |
|---|---|---|
| 1 | **A rate-limited call emits no span.** `meteredHost` charges the budget outside `guard`, so a throttled call returns before the tracing wrapper opens — the one event an operator most wants ("which principal is hitting the budget, on which tool") is the only one with no telemetry, and the only `isError` path `recordSpanFailure` can never see | Layering change, not a defect. Fix by charging inside `guard` or opening the span in the metered wrapper; the constraint that `requestState` verification precedes the charge is unaffected either way |
| 2 | **A handoff is indistinguishable from a success in traces.** An `input_required` result correctly ends its span UNSET, but nothing marks it, so "how often are we asking humans, and on which tool" is unanswerable | Wants a `steel.handoff.round` span attribute plus a span-status assertion for the `input_required` outcome, which the tracing suite currently only covers for plain successes |
| 3 | **MRTR detection costs a full a11y snapshot on every `steel_navigate` and `steel_act`** — and a second one when `include_snapshot` is true, because `snapshotSection` only reuses the cached snapshot when a cursor was passed. It also uses the *full* tree where the rendered path uses `interactiveOnly` | Contradicts `steel_navigate`'s own description (the CDP cost is now paid regardless; only tokens are saved). Element refs are safe — verified, `lastSeenSnapshotId` is recorded before the keep filter, so the detection snapshot refreshes rather than supersedes. Cheapest fix: have `snapshotSection` reuse the detection snapshot |
| 4 | **`steel_batch` is 6 units for up to 20 steps and has no handoff wiring.** Twenty `steel_act` calls cost 60 individually, 6 batched — a 10× discount on the tool with the heaviest CDP load; and a batch step hitting a login wall gets the plain error, though form-filling and checkout stepping are exactly the flows batch exists for | Both look intentional, so flagging rather than changing. If the pricing is deliberate it belongs in the `TOOL_COSTS` comment, which currently argues the other way |
| 5 | **The hosted `tenants` map never evicts.** Pre-existing, not from P2 — but the limiter next door prunes at 4096 principals, so the asymmetry is now visible | Unbounded growth keyed by principal on a long-lived replica. Wants the same pruning treatment |
| 6 | **`forget()` deletes the record key unconditionally while `list()` passes the caller's principal**, so a stale index entry naming another tenant's handle would delete that tenant's record | Unreachable: handles are 128 bits of CSPRNG, the live-index member would survive, and the next sweep self-heals. Becomes live only if handles ever stop being random |
| 7 | **`steel_session_diagnostics` filters `since` client-side**, after fetching the whole timeline. Both Steel endpoints accept `startTime`/`endTime`, and one page load produces ~84 log entries, so the waste is real | Small change, pure efficiency, no correctness impact. Do it when the tool is next touched |

**Steel API shapes still unverified** (2026-07-31, after a live probe settled the envelope bugs). Each is
handled tolerantly in `src/core/steel/diagnostics.ts` rather than assumed, so none is a live defect:
`hasMore` was never observed true and no `limit`/`offset`/`cursor` param is documented, so how a caller
fetches a remainder is unknown; no `error` *activity* was produced by the probe, so `AgentTrace.error`
stays `unknown` behind a reader accepting a string or `{message}`; whether a `Navigation` log payload
can carry a from/to pair rather than `navigation.url`; and whether `Response`/`RequestFailed` payloads
carry a status code worth rendering. Observed activity types include `change` and `submit`, neither of
which Steel documents — so nothing may switch exhaustively on `type`.

---

*Branch `niko/steel-mcp-server-v2`. Protocol, SDK and competitor facts verified 2026-07-27, spec-final and extension facts 2026-07-30; see RESEARCH.md for sourcing and for the claims the fact-checkers refuted.*
