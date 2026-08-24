// ABOUTME: Deterministic session recipes and the short-lived signed configuration passed from the
// ABOUTME: account-aware options tool into session creation without exposing arbitrary Steel JSON.
import { createRequestStateCodec, type RequestStateCodec } from '@modelcontextprotocol/server';

export type SessionGoal = 'read' | 'interact' | 'account';
export type SessionNeed =
    | 'long_running'
    | 'protected_text'
    | 'human_captcha'
    | 'persist_profile'
    | 'mobile'
    | 'location';

export interface SessionPlanSettings {
    timeout?: number;
    useProxy?: true | { geolocation: { country: string } };
    solveCaptcha?: true;
    stealthConfig?: { autoCaptchaSolving: false };
    optimizeBandwidth?: { blockImages: true; blockMedia: true; blockStylesheets: false };
    deviceConfig?: { device: 'mobile' };
    persistProfile?: true;
}

export interface SessionPlanState {
    v: 1;
    origin: string;
    goal: SessionGoal;
    settings: SessionPlanSettings;
    accountContext: boolean;
    profileSelection?: { mode: 'automatic'; profileId: string } | { mode: 'required'; availableProfiles: number };
}

export interface RecipeInput {
    origin: string;
    goal: SessionGoal;
    needs: SessionNeed[];
    minutes?: number;
    country?: string;
    configuredTimeoutMs: number;
    accountMaxMs?: number;
}

export interface Recipe {
    recommendedTool: 'steel_scrape' | 'steel_session_create';
    state?: SessionPlanState;
    rationale: string[];
    warnings: Array<{ code: string; message: string }>;
}

export function createSessionPlanCodec(secret: string, principal: string): RequestStateCodec<SessionPlanState> {
    return createRequestStateCodec<SessionPlanState>({
        key: secret,
        ttlSeconds: 600,
        bind: () => `steel.session-plan.v1\0${principal}`,
    });
}

/** Pure recipe table: settings are added only for explicit semantic needs. */
export function recommendSession(input: RecipeInput): Recipe {
    const needs = new Set(input.needs);
    if (input.goal === 'read' && needs.size === 0) {
        return {
            recommendedTool: 'steel_scrape',
            rationale: ['A stateless read needs no billed browser.'],
            warnings: [],
        };
    }
    const settings: SessionPlanSettings = {};
    const rationale: string[] = [];
    const warnings: Recipe['warnings'] = [];
    if (needs.has('long_running')) {
        const requested = (input.minutes ?? 0) * 60_000;
        const effective = input.accountMaxMs === undefined ? requested : Math.min(requested, input.accountMaxMs);
        if (effective > input.configuredTimeoutMs) settings.timeout = effective;
        rationale.push(
            effective < requested
                ? 'Duration was clamped to the account maximum.'
                : 'Duration covers the requested active task.'
        );
    }
    if (needs.has('protected_text')) {
        settings.useProxy = true;
        settings.solveCaptcha = true;
        settings.optimizeBandwidth = { blockImages: true, blockMedia: true, blockStylesheets: false };
        rationale.push(
            'Protected reading uses a residential proxy, CAPTCHA solving, and conservative bandwidth blocking.'
        );
    }
    if (needs.has('human_captcha')) {
        settings.solveCaptcha = true;
        settings.stealthConfig = { autoCaptchaSolving: false };
        rationale.push('CAPTCHA solving is available, while automatic solving is disabled for human handoff.');
    }
    if (needs.has('mobile')) settings.deviceConfig = { device: 'mobile' };
    if (needs.has('location')) settings.useProxy = { geolocation: { country: input.country ?? '' } };
    if (needs.has('persist_profile')) {
        settings.persistProfile = true;
        warnings.push({
            code: 'profile_will_change',
            message: 'The selected profile is saved when the session is released.',
        });
    }
    return {
        recommendedTool: 'steel_session_create',
        state: { v: 1, origin: input.origin, goal: input.goal, settings, accountContext: input.goal === 'account' },
        rationale: rationale.length ? rationale : ['A stateful interaction needs one live browser session.'],
        warnings,
    };
}
