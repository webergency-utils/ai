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

export class BudgetExceededError extends AIError
{
    public readonly currentSpendUSD : number;
    public readonly budgetLimitUSD  : number;

    constructor( currentSpendUSD: number, budgetLimitUSD: number )
    {
        super( 
            `Budget cap exceeded: current spend $${currentSpendUSD.toFixed( 4 )} exceeds limit $${budgetLimitUSD.toFixed( 4 )}`, 
            'BUDGET_EXCEEDED', 
            { currentSpendUSD, budgetLimitUSD } 
        );
        this.name = 'BudgetExceededError';
        this.currentSpendUSD = currentSpendUSD;
        this.budgetLimitUSD = budgetLimitUSD;
    }
}
