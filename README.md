# Steel MCP Server

[![Release](https://img.shields.io/github/v/release/steel-dev/steel-mcp-server?label=release)](https://github.com/steel-dev/steel-mcp-server/releases/latest)
[![CI](https://github.com/steel-dev/steel-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/steel-dev/steel-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)

Give Claude, Cursor, or any MCP client a real Chrome in the cloud. Read pages that block a plain
`fetch`, fill forms, take screenshots, and hand the browser to a person when a login or a CAPTCHA
needs one. The browser is run by [Steel](https://steel.dev).

**Status:** `2.0.1`. Download it from [Releases](https://github.com/steel-dev/steel-mcp-server/releases/latest).
It is not published to npm. `mcp.steel.dev` is not live yet.

## Install

You need a [Steel API key](https://app.steel.dev/settings/api-keys). The free tier is enough to try it.

### Claude for macOS or Windows

Download [`steel-mcp-2.0.1.mcpb`](https://github.com/steel-dev/steel-mcp-server/releases/latest)
and open it. Claude installs it and asks for your Steel API key. No Node install is needed.

When you replace an installed bundle, quit and reopen Claude after the installer finishes, then start
a new conversation so Claude reads the new tool catalog.

### Claude Code

```bash
claude mcp add steel -e STEEL_API_KEY=your-steel-api-key -- npx -y github:steel-dev/steel-mcp-server
```

The first run clones and builds the server, which takes about a minute. Later runs start at once.

### Cursor, VS Code, and other MCP clients

Add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "steel": {
      "command": "npx",
      "args": ["-y", "github:steel-dev/steel-mcp-server"],
      "env": { "STEEL_API_KEY": "<your-steel-api-key>" }
    }
  }
}
```

To run from a checkout instead, `npm install` builds the server; point `command` at `node` and
`args` at `/absolute/path/to/steel-mcp-server/dist/stdio.js`.

### Self-hosted steel-browser

Run the [steel-browser](https://github.com/steel-dev/steel-browser) image and set `STEEL_LOCAL=true`
instead of an API key. No key is needed or sent. Self-hosted Steel runs one browser session at a
time and has no managed proxies, browser profiles, managed credentials, or CAPTCHA solving; a tool
that asks for one of those gets a named explanation instead.

### A shared endpoint for a team

`dist/hosted.js` serves the same tools over Streamable HTTP, with each caller bringing their own
Steel key. Claude Code connects to it directly; Claude Desktop needs the `mcp-remote` bridge.
Deployment, Redis, tracing, and the client snippets are in [docs/HOSTING.md](docs/HOSTING.md).

## What you can ask

| Ask | What happens |
|---|---|
| "Read this page and summarize the pricing table." | One `steel_scrape`. No browser session, nothing to release |
| "Compare the price of this product across these three shops." | Three stateless reads, or a session when a shop needs JavaScript to render |
| "Sign in to my account and check last month's invoice." | A session, a snapshot, and the browser handed to you at the login wall. The server never guesses a password |
| "Fill out this application with the details from my CV." | The agent fills the ordinary fields, then `steel_session_handoff` lets you choose the CV locally in the same browser |
| "Screenshot the top of this article for a slide." | One `steel_screenshot`, shown inline when small enough and always linked for download |
| "What happened in my last browser session?" | `steel_session_diagnostics` reads the latest released session. No new browser is started |

## How it works

- **Read first, browse when you must.** `steel_scrape` answers most questions about a page and starts
  no billed session. A session is created only to interact, and released when the task is done.
- **Elements, not pixels.** `steel_snapshot` and `steel_find` read the page as an accessibility tree
  and give targetable elements `@eN` references. `steel_act` clicks, types, and fills by reference.
  Screenshots are for people and for visual checks, never for aiming.
- **Actions report what changed.** A click returns whether the page navigated, the DOM changed, or
  focus moved. If nothing changed, the response says so instead of claiming success. When a
  reference stops working, the error says why and what to call next.
- **The Steel skills ride along.** The five published
  [Steel skills](https://github.com/steel-dev/skills) are served as `skill://` resources — plain
  `resources/list` and `resources/read`, no extension support needed. The server instructions point
  the model at `skill://steel-browser/SKILL.md` for the flows a tool list cannot teach, and the
  skills cross-handoff to each other for debugging and reliability. Markdown guidance only;
  vendored at build time from a pinned upstream revision.
- **People handle the sensitive parts.** On a host with MCP Apps, Claude among them, the running
  browser renders inline in the conversation. **Take control** gives you the browser for a login, a
  CAPTCHA, a payment, or a local file; **Hand back** returns it, and the agent re-reads the page
  before it continues. Login walls and CAPTCHAs trigger the handoff automatically. Saved browser
  profiles and managed credentials are discovered through `steel_session_options`, never guessed.
  Details in [docs/SESSIONS.md](docs/SESSIONS.md).
- **Page content is data, not instructions.** Everything read from a page arrives inside an
  `<untrusted-page-content>` block with hidden text and other prompt-injection carriers stripped.
  Passwords and credentials are redacted before they reach a response or a log.

## Tools

The default `browse` profile exposes sixteen tools. `STEEL_PROFILE=scrape` exposes only the first
three, which never start a browser.

<details>
<summary>The full table</summary>

| Tool | What it does |
|---|---|
| `steel_scrape` | Read a budgeted page plus bounded links and metadata. Starts no browser session |
| `steel_screenshot` | Capture a URL for a person, or a live session for a visual check; URL captures support proxies |
| `steel_pdf` | Render a page to PDF and return a link; supports proxies |
| `steel_session_create` | Start a browser session you can interact with |
| `steel_session_release` | Shut it down and stop the meter |
| `steel_navigate` | Point a session at a URL |
| `steel_snapshot` | Read the page as an accessibility tree with `@eN` references |
| `steel_find` | Locate elements by text, safe regex, or role without reading the whole page |
| `steel_act` | Click, type, fill a form, select, hover, scroll, press a key, go back, dismiss overlays |
| `steel_wait_for` | Wait for named text, a selector, or a URL |
| `steel_session_diagnostics` | Read a session's activity, or rediscover this credential's live handles, without starting a browser |
| `steel_session_handoff` | Pause while a person takes exclusive control of the same browser, then return it to the agent |
| `steel_session_replay` | On an explicit request, return a finished session's Steel dashboard link |
| `steel_batch` | Run known reversible steps in one call; hands off before login, payment, or final confirmation |
| `steel_session_options` | Plan a non-default session and discover saved profile IDs or managed-login namespaces |
| `steel_session_live_view` | Feeds the inline viewer its connection details. Hosts hide it from the model |

</details>

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `STEEL_API_KEY` | | Required for Steel Cloud. Never sent to a self-hosted deployment |
| `STEEL_LOCAL` | `false` | `true` drives a local steel-browser and waives the API key |
| `STEEL_BASE_URL` | `https://api.steel.dev` | Steel REST base URL. A trailing `/v1` is fine either way |
| `STEEL_PROFILE` | `browse` | `browse` or `scrape` |
| `STEEL_SESSION_TIMEOUT_MS` | `900000` | Default immutable session lifetime. A create request may choose up to 24 hours, within the account maximum |
| `STEEL_INACTIVITY_TIMEOUT_MS` | `600000` | Idle release. Long enough for a handoff, so an abandoned browser can live about 10 minutes |
| `STEEL_MAX_SESSIONS` | `10` | Concurrent sessions this server will hold |
| `STEEL_CONNECT_URL` | `wss://connect.steel.dev` | CDP endpoint, derived from the base URL when self-hosted |

Logs are structured JSON on stderr; stdout carries nothing but JSON-RPC. The hosted endpoint has its
own variables, listed in [docs/HOSTING.md](docs/HOSTING.md).

## Troubleshooting

**A site returns 403 or shows a challenge page.** That is bot detection, not a bug. The error names
the vendor and one thing to try next; change one thing at a time. `steel_session_diagnostics` shows
what happened.

**Managed proxies or CAPTCHA solving fail with a payment error.** Those need a $10 verified paid
balance on Launch; free credits do not count.

**A `@eN` reference stopped working.** The error says why: the page navigated, the frame holding it
loaded a new document, the node was removed, or the element changed role or name. It also says what
to call to recover.

**A click reports that nothing changed.** It probably landed on something else. If an overlay covers
the target, the error names it: run `steel_act` with `dismiss_overlays`, then retry. If the target is
inside a frame, the response says the frame is not observed; take a fresh snapshot instead of
clicking again.

**A session seems to have vanished.** Steel releases a session after ten minutes without activity,
and at the plan's hard time limit. Create a new one only if you need to interact again; to read the
old activity, call `steel_session_diagnostics` with its dashboard UUID, or with no id for the latest.

**"Concurrency limit reached" on `steel_session_create`.** Your Steel plan allows fewer simultaneous
browsers than are open. Sessions you forgot to release count; `steel_session_release` frees one
immediately.

**The extension fails to start with a message about `STEEL_API_KEY`.** The key never reached the
server. Open the extension's settings in Claude and enter it again; the field is write-only, so a
blank one looks the same as a filled one.

**Tracing was requested but could not start.** The desktop bundle ships without the OpenTelemetry
exporter stack. The server logs this once and serves normally; a source checkout can install
`@opentelemetry/sdk-node` and `@opentelemetry/exporter-trace-otlp-http`.

## Security and privacy

The server holds no data of its own. It sends the URLs and page interactions a tool call names to
Steel, which runs the browser, and returns what the page said. Page content passes through to your
MCP client and is not stored, logged, or forwarded anywhere else. Nothing about your conversation is
collected, and no telemetry exporter is loaded unless you configure one with a standard `OTEL_*`
variable. Steel's handling of the browser sessions it runs is covered by the
[Steel privacy policy](https://steel.dev/privacy).

Web pages can contain prompt injections, and filtering cannot remove every one. Review browser
actions that submit data, make purchases, or change an account. The threat model and the current
mitigations are in [RESEARCH.md §7](RESEARCH.md#7-security). Report vulnerabilities as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm test               # unit + integration
npm run budget         # tools/list byte budget per profile
npm run conformance    # MCP conformance suite
npm run test:browser   # runs the inline viewer and the frame snapshot in a real Chrome
npm run test:e2e       # starts, waits for and tears down the real-browser stack
```

[CLAUDE.md](CLAUDE.md) has the working rules; this project practises TDD, so a change starts with a
failing test. [RELEASING.md](RELEASING.md) explains what ships from this one package: the desktop
bundle, the container image, and the hosted service. [NOTES.md](NOTES.md) records what was measured
against Steel's API and Chrome, and [RESEARCH.md](RESEARCH.md) the decisions behind the design.

Contributions are welcome: fork, branch, and open a pull request that says what it changes and why.
For bugs, [open an issue](https://github.com/steel-dev/steel-mcp-server/issues) with the tool you
called and the error text.
