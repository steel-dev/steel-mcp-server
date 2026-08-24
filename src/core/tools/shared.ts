// ABOUTME: Shared plumbing for tool handlers: the handle-to-page resolution that re-authorises on
// ABOUTME: every call, the untrusted-content fence around page text, and uniform error handling.
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerDeps } from '../context.js';
import { type EnvelopeSections, successResult } from '../envelope.js';
import { toolErrorResult } from '../errors.js';
import type { BrowserPage } from '../page.js';
import { DEFAULT_MAX_TOKENS, paginate } from '../pagination.js';
import type { HandleRecord } from '../registry.js';
import type { PageSnapshot } from '../snapshot.js';
import { recordSpanFailure, resolveTracer, withToolCallSpan } from '../telemetry.js';
import { fenceUntrusted } from '../untrusted.js';

/** The `session_id` argument shared by every stateful tool. */
export const sessionIdSchema = z.string().describe('Live session_id from steel_session_create.');

export const maxTokensSchema = z
    .number()
    .int()
    .positive()
    .max(100_000)
    .optional()
    .describe(`Cap on the text returned, in tokens. Defaults to ${DEFAULT_MAX_TOKENS}.`);

/** Compact wire representation of a UUID while retaining strict runtime validation. */
export const uuidSchema = z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

export const cursorSchema = z
    .string()
    .optional()
    .describe('Cursor from a previous truncated response, to continue reading where it stopped.');

/**
 * What a tool handler needs from the request it is answering: cancellation, and the `_meta` the
 * caller's trace context arrives in. Taken from the SDK context so it cannot drift from it.
 */
export type ToolRequest = Pick<ServerContext['mcpReq'], 'signal' | '_meta'>;

/**
 * A tool outcome: an ordinary result, or the input_required result a human-in-the-loop handoff
 * returns when a person has to finish the step in the live browser.
 */
export type ToolOutcome = CallToolResult | InputRequiredResult;

/**
 * Runs a handler inside its tool-call span and converts anything it throws into an error result.
 *
 * The span is the outermost layer so a failure is recorded as one before it becomes an ordinary
 * result. It records the error code only, and never touches the bytes the caller receives.
 */
export async function guard(
    deps: ServerDeps,
    toolName: string,
    request: ToolRequest,
    work: () => Promise<ToolOutcome>
): Promise<ToolOutcome> {
    return withToolCallSpan(
        resolveTracer(deps.tracer),
        {
            toolName,
            profile: deps.config.profile,
            deployment: deps.config.deployment,
            principal: deps.principal,
        },
        request._meta,
        async span => {
            try {
                return await work();
            } catch (error) {
                recordSpanFailure(span, error);
                return toolErrorResult(error);
            }
        }
    );
}

/**
 * Resolves a handle to its live page, re-authorising against this request's own principal.
 *
 * The check is deliberately repeated on every call and never cached from creation time: a
 * handle is an identifier, not a bearer capability, and a leaked one must not grant a stranger
 * a live, possibly logged-in browser.
 */
export async function withPage(
    deps: ServerDeps,
    toolName: string,
    request: ToolRequest,
    sessionId: string,
    work: (page: BrowserPage, record: HandleRecord) => Promise<ToolOutcome>
): Promise<ToolOutcome> {
    return guard(deps, toolName, request, async () => {
        const record = await deps.registry.resolveForAgent(sessionId, deps.principal);
        await deps.registry.touch(sessionId);
        const page = await deps.pool.page(record.steelSessionId, request.signal);
        return work(page, record);
    });
}

/** Wraps page-derived text in the provenance fence and applies the token budget with a cursor. */
export function fencedSection(
    body: string,
    provenance: { finalUrl: string; fetchedAt: string },
    options: { maxTokens?: number | undefined; cursor?: string | undefined }
): { text: string; pagination: string | undefined } {
    const page = paginate(body, options);
    const text = fenceUntrusted(page.text, provenance);
    return {
        text,
        pagination: page.truncated
            ? `Truncated at the token budget (about ${page.totalTokens} tokens in total). ` +
              `Call this tool again with cursor="${page.nextCursor}" to continue.`
            : undefined,
    };
}

/** Renders the fixed one-line page-state section shared by the stateful tools. */
export function pageStateLine(
    snapshot: Pick<PageSnapshot, 'url' | 'title' | 'snapshotId' | 'unreadableFrames'>
): string {
    const missing = snapshot.unreadableFrames;
    // A form inside a frame that was not read is absent from the snapshot, and nothing else on the
    // page looks wrong, so the count is part of the page state rather than a footnote.
    const frames =
        missing === 0
            ? ''
            : ` — ${missing} frame${missing === 1 ? '' : 's'} could not be read, so anything inside is missing`;
    return `${snapshot.url}${snapshot.title ? ` — ${snapshot.title}` : ''} (snapshot ${snapshot.snapshotId})${frames}`;
}

export type Sections = EnvelopeSections;
export { successResult };
