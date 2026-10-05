export class AIError extends Error
{
    public readonly code    : string;
    public readonly details : unknown;

    constructor( message: string, code: string = 'AI_ERROR', details?: unknown )
    {
        super( message );
        this.name = 'AIError';
        this.code = code;
        this.details = details;
    }
}

export class ProviderError extends AIError
{
    public readonly provider   : string;
    public readonly statusCode : number;

    constructor( provider: string, message: string, statusCode: number = 500, details?: unknown )
    {
        super( `[${provider}] ${message}`, 'PROVIDER_ERROR', details );
        this.name = 'ProviderError';
        this.provider = provider;
        this.statusCode = statusCode;
    }
}

export class RateLimitError extends ProviderError
{
    public readonly retryAfterSeconds? : number;

    constructor( provider: string, message: string = 'Rate limit exceeded', retryAfterSeconds?: number, details?: unknown )
    {
        super( provider, message, 429, details );
        this.name = 'RateLimitError';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

export class MissingDependencyError extends AIError
{
    public readonly packageName : string;
    public readonly installCmd  : string;

    constructor( packageName: string )
    {
        const installCmd = `npm install ${packageName}`;

        super( 
            `Missing dependency: please install ${packageName} using '${installCmd}'`, 
            'MISSING_DEPENDENCY', 
            { packageName, installCmd } 
        );
        this.name = 'MissingDependencyError';
        this.packageName = packageName;
        this.installCmd = installCmd;
    }
}

export class InvalidInputError extends AIError
{
    constructor( message: string, details?: unknown )
    {
        super( message, 'INVALID_INPUT', details );
        this.name = 'InvalidInputError';
    }
}

export class CapabilityError extends AIError
{
    public readonly provider   : string;
    public readonly capability : string;

    constructor( provider: string, capability: string, message?: string, details?: unknown )
    {
        super( 
            `[${provider}] Unsupported capability '${capability}'${message ? `: ${message}` : ''}`, 
            'UNSUPPORTED_CAPABILITY', 
            { provider, capability, ...( details && typeof details === 'object' ? details as object : {} ) } 
        );
        this.name = 'CapabilityError';
        this.provider = provider;
        this.capability = capability;
    }
}

export class InputLimitError extends AIError
{
    public readonly provider        : string;
    public readonly scope           : string;
    public readonly estimatedTokens?: number;
    public readonly limitTokens?    : number;

    constructor( provider: string, scope: string, estimatedTokens?: number, limitTokens?: number, details?: unknown )
    {
        super( 
            `[${provider}] Request exceeds the model's input limit (${scope})${estimatedTokens !== undefined && limitTokens !== undefined ? `: about ${estimatedTokens} tokens, limit ${limitTokens}` : ''}. Input is never truncated; shorten the input or questions`, 
            'INPUT_LIMIT_EXCEEDED', 
            { provider, scope, estimatedTokens, limitTokens, ...( details && typeof details === 'object' ? details as object : {} ) } 
        );
        this.name = 'InputLimitError';
        this.provider = provider;
        this.scope = scope;
        this.estimatedTokens = estimatedTokens;
        this.limitTokens = limitTokens;
    }
}

export class BudgetExceededError extends AIError
{
    public readonly currentSpendUSD : number;
    public readonly budgetLimitUSD  : number;
    public readonly category?       : string;

    constructor( currentSpendUSD: number, budgetLimitUSD: number, category?: string )
    {
        const message = category
            ? `Category '${category}' budget cap exceeded: current spend $${currentSpendUSD.toFixed( 4 )} exceeds limit $${budgetLimitUSD.toFixed( 4 )}`
            : `Budget cap exceeded: current spend $${currentSpendUSD.toFixed( 4 )} exceeds limit $${budgetLimitUSD.toFixed( 4 )}`;

        super( 
            message, 
            'BUDGET_EXCEEDED', 
            { currentSpendUSD, budgetLimitUSD, category } 
        );
        this.name = 'BudgetExceededError';
        this.currentSpendUSD = currentSpendUSD;
        this.budgetLimitUSD = budgetLimitUSD;
        this.category = category;
    }
}

export class TimeoutError extends AIError
{
    public readonly phase     : 'total' | 'idle';
    public readonly timeoutMs : number;
    public readonly attempt?  : number;

    constructor( 
        message: string, 
        phase: 'total' | 'idle', 
        timeoutMs: number, 
        attempt?: number, 
        details?: unknown 
    )
    {
        super( message, 'TIMEOUT', { phase, timeoutMs, attempt, ...( details && typeof details === 'object' ? details as object : { details } ) } );
        this.name = 'TimeoutError';
        this.phase = phase;
        this.timeoutMs = timeoutMs;
        this.attempt = attempt;
    }
}

export class CancelledError extends AIError
{
    public readonly cause? : unknown;

    constructor( message: string = 'Operation cancelled', cause?: unknown )
    {
        super( message, 'CANCELLED', { cause } );
        this.name = 'CancelledError';
        this.cause = cause;
    }
}

export class QuotaExceededError extends AIError
{
    public readonly provider   : string;
    public readonly statusCode : number;

    constructor( provider: string, message: string = 'Quota or billing limit exceeded', details?: unknown )
    {
        super( `[${provider}] ${message}`, 'QUOTA_EXCEEDED', details );
        this.name = 'QuotaExceededError';
        this.provider = provider;
        this.statusCode = 429;
    }
}

export class BudgetRefusedError extends AIError
{
    public readonly reason : 'exhausted' | 'unpriced';
    public readonly provider? : string;
    public readonly model?    : string;

    constructor( 
        reason: 'exhausted' | 'unpriced', 
        message: string, 
        opts: { provider?: string, model?: string } = {} 
    )
    {
        super( 
            message, 
            reason === 'unpriced' ? 'UNPRICED_MODEL' : 'BUDGET_REFUSED', 
            { reason, ...opts } 
        );
        this.name = 'BudgetRefusedError';
        this.reason = reason;
        this.provider = opts.provider;
        this.model = opts.model;
    }
}

export class DimensionMismatchError extends AIError
{
    public readonly expected : number;
    public readonly actual   : number;

    constructor( expected: number, actual: number )
    {
        super( 
            `Vector dimension mismatch: expected ${expected}, got ${actual}`, 
            'DIMENSION_MISMATCH', 
            { expected, actual } 
        );
        this.name = 'DimensionMismatchError';
        this.expected = expected;
        this.actual = actual;
    }
}

export class PathEscapeError extends AIError
{
    public readonly path : string;

    constructor( path: string, message?: string )
    {
        super( 
            message ?? `Path escapes store root: ${path}`, 
            'PATH_ESCAPE', 
            { path } 
        );
        this.name = 'PathEscapeError';
        this.path = path;
    }
}


export type GuardrailStage = 'input' | 'toolCall' | 'toolResult' | 'output';

/** Thrown when a guardrail denies a run (input / output, or any `tripwire` deny) or itself throws (fail closed). */
export class GuardrailTripwireError extends AIError
{
    public readonly stage  : GuardrailStage;
    public readonly reason : string;

    constructor( stage: GuardrailStage, reason: string, cause?: unknown )
    {
        super( 
            `Guardrail tripped at '${stage}': ${reason}`, 
            'AGENT_GUARDRAIL_TRIPPED', 
            { stage, reason, ...( cause !== undefined ? { cause : cause instanceof Error ? `${cause.name}: ${cause.message}` : String( cause ) } : {} ) } 
        );
        this.name = 'GuardrailTripwireError';
        this.stage = stage;
        this.reason = reason;

        if( cause !== undefined )
        {
            this.cause = cause;
        }
    }
}
