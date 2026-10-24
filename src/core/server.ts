// ABOUTME: Assembles an McpServer for one profile: registers the tool table in a fixed order, serves
// ABOUTME: the live-view app and skill resources, and sets the cache hints the 2026-07-28 revision requires.
import { McpServer } from '@modelcontextprotocol/server';
import { SESSION_VIEWER_HTML, SESSION_VIEWER_MIME_TYPE, SESSION_VIEWER_URI } from './apps/session-viewer.js';
import type { SteelConfig } from './config.js';
import type { ServerDeps, ToolHost } from './context.js';
import { toolErrorResult } from './errors.js';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import { toolsForProfile } from './profiles.js';
import type { RateLimiter } from './rate-limit.js';
import { registerSkillResources } from './skills/resources.js';
import { SERVER_VERSION } from './version.js';

/** One hour. The tool list and viewer shell are org-independent, so both cache publicly. */
const PUBLIC_CACHE_TTL_MS = 3_600_000;

/** The MCP Apps extension, negotiated per request under `capabilities.extensions`. */
export const UI_EXTENSION_NAME = 'io.modelcontextprotocol/ui';

/**
 * Builds the `_meta.ui` a host reads off the viewer resource.
 *
 * `connectDomains` is the CSP allowlist the host turns into `connect-src`, and the shell has exactly
 * one origin to reach: the CDP endpoint this deployment is configured for. Deriving it from
 * `connectUrl` rather than naming Steel Cloud is what lets a self-hosted deployment declare its own
 * host — a hardcoded `wss://connect.steel.dev` would leave that shell unable to connect at all.
 */
function sessionViewerUiMeta(config: SteelConfig): Record<string, unknown> {
    return {
        csp: { connectDomains: [new URL(config.connectUrl).origin] },
        prefersBorder: true,
    };
}

/**
 * Publishes the viewer shell at its `ui://` URI.
 *
 * The `_meta.ui` is set on the list entry and again on the content item, because the spec makes the
 * content item authoritative and a host that only ever reads the resource must still see the CSP.
 *
 * The per-resource cache hint deliberately contradicts the server-level `resources/read` hint below.
 * That hint exists because anything derived from an authenticated principal must not reach a shared
 * cache; this resource is a static shell with no session, no org and no credential in it, so an hour
 * in a shared cache is safe and saves the host re-fetching it for every conversation.
 */
function registerSessionViewer(server: McpServer, config: SteelConfig): void {
    const ui = sessionViewerUiMeta(config);
    server.registerResource(
        'session-viewer',
        SESSION_VIEWER_URI,
        {
            title: 'Live browser session',
            description: 'Watches and securely takes control of the same live browser, inline in the conversation.',
            mimeType: SESSION_VIEWER_MIME_TYPE,
            _meta: { ui },
            cacheHint: { ttlMs: PUBLIC_CACHE_TTL_MS, cacheScope: 'public' },
        },
        uri => ({
            contents: [
                {
                    uri: uri.href,
                    mimeType: SESSION_VIEWER_MIME_TYPE,
                    text: SESSION_VIEWER_HTML,
                    _meta: { ui },
                },
            ],
        })
    );
}

/** A registration with the SDK's generics erased. Forwarding arguments needs nothing more. */
type ErasedRegisterTool = (name: string, config: unknown, handler: (...args: unknown[]) => unknown) => unknown;

/**
 * Wraps the registration surface so every tool charges the request budget before it runs.
 *
 * Metering at registration rather than inside each handler is what makes the guarantee hold for
 * the whole table, including tools added later. A rejection comes back as a tool-execution error,
 * not a protocol error, so the model reads the reason and the retry-after and can act on both.
 *
 * `registerTool` is overloaded and generic and its callback type is conditional on the input
 * schema, so a wrapper that only forwards its arguments cannot be spelled in those types. The two
 * casts erase them and restore them again around a body that inspects nothing but the tool name.
 */
function meteredHost(server: McpServer, limiter: RateLimiter, principal: string): ToolHost {
    const register = server.registerTool.bind(server) as unknown as ErasedRegisterTool;
    const metered: ErasedRegisterTool = (name, config, handler) =>
        register(name, config, async (...args) => {
            try {
                await limiter.charge(principal, name);
            } catch (error) {
                return toolErrorResult(error);
            }
            return handler(...args);
        });
    return { registerTool: metered as unknown as ToolHost['registerTool'], server: server.server };
}

/**
 * Builds a server instance.
 *
 * Called once per connection on stdio and once per request behind the HTTP entry, so it must stay
 * cheap: everything expensive lives in `deps`, created once at module scope and closed over here.
 */
export function createSteelMcpServer(deps: ServerDeps): McpServer {
    const server = new McpServer(
        { name: 'steel', title: 'Steel Browser', version: SERVER_VERSION },
        {
            capabilities: {
                tools: {},
                // `listChanged: false` is stated rather than left to the SDK's default, which would
                // claim a notification this server never sends. The resource set is fixed at build
                // time, so nothing can change for a client to be told about.
                resources: { listChanged: false },
                extensions: { [UI_EXTENSION_NAME]: {} },
            },
            instructions: SERVER_INSTRUCTIONS,
            cacheHints: {
                // The tool list depends on the profile, not on who is asking.
                'tools/list': { ttlMs: PUBLIC_CACHE_TTL_MS, cacheScope: 'public' },
                'server/discover': { ttlMs: PUBLIC_CACHE_TTL_MS, cacheScope: 'public' },
                // Anything derived from an authenticated principal must never reach a shared cache.
                'resources/read': { ttlMs: 0, cacheScope: 'private' },
                'resources/list': { ttlMs: 0, cacheScope: 'private' },
            },
            // Runs before any handler sees a retried human-in-the-loop call, so tampered, expired
            // or replayed state is refused at the seam and never reaches the tool layer.
            requestState: { verify: deps.handoffState.verify },
        }
    );

    registerSessionViewer(server, deps.config);
    // The skill set is as fixed as the viewer shell: vendored at build time, identical for every
    // principal and profile, so it registers the same way on both transports and never notifies.
    registerSkillResources(server);

    const host = deps.limiter ? meteredHost(server, deps.limiter, deps.principal) : server;
    for (const tool of toolsForProfile(deps.config.profile)) {
        tool.register(host, deps);
    }

    return server;
}
