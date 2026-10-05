import type { ModelProtocol } from '../core/protocol.js';
import type { ModelRequest, ModelResponse, ModelStreamChunk } from '../core/types.js';
import type { SpendTracker } from '../spend/tracker.js';
import type { Span } from '../trace/types.js';

export interface MeteredModelOptions
{
    tracker   : SpendTracker
    /** Optional override when the adapter's configured base URL is non-default. */
    baseUrl?  : string
    /** Optional active span for post-call spend attachment (R28). */
    getSpan?  : () => Span | undefined
    threadId? : string
    agentId?  : string
}

/**
 * Metering wrapper around ModelProtocol (KTD2).
 * Pre-checks model budgets / unpriced caps, records usage or gaps, observes retries.
 */
export class MeteredModel implements ModelProtocol
{
    readonly #inner   : ModelProtocol;
    readonly #tracker : SpendTracker;
    readonly #baseUrl?: string;
    readonly #getSpan?: () => Span | undefined;
    readonly #threadId?: string;
    readonly #agentId?: string;

    constructor( inner: ModelProtocol, options: MeteredModelOptions )
    {
        this.#inner = inner;
        this.#tracker = options.tracker;
        this.#baseUrl = options.baseUrl;
        this.#getSpan = options.getSpan;
        this.#threadId = options.threadId;
        this.#agentId = options.agentId;
    }

    public get provider(): string
    {
        return this.#inner.provider;
    }

    public get model(): string
    {
        return this.#inner.model;
    }

    public get inner(): ModelProtocol
    {
        return this.#inner;
    }

    public async generate( request: ModelRequest ): Promise<ModelResponse>
    {
        this.#preflight();

        const response = await this.#inner.generate( this.#withAttemptObserver( request ) );
        this.#recordResponse( response );

        return response;
    }

    public async* stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
    {
        this.#preflight();

        let usage: ModelResponse['usage'];
        let sawChunk = false;

        try
        {
            for await ( const chunk of this.#inner.stream( this.#withAttemptObserver( request ) ) )
            {
                sawChunk = true;

                if( chunk.usage )
                {
                    usage = chunk.usage;
                }

                yield chunk;
            }
        }
        catch( error )
        {
            if( sawChunk )
            {
                this.#tracker.recordSpendGap( 
                    `Stream abandoned after headers for ${this.provider}:${this.model}`, 
                    { provider : this.provider, model : this.model, error }, 
                    { threadId : this.#threadId, agentId : this.#agentId } 
                );
            }

            throw error;
        }

        if( usage )
        {
            this.#recordUsage( usage );
        }
        else
        {
            this.#tracker.recordSpendGap( 
                `Stream completed without usage for ${this.provider}:${this.model}`, 
                { provider : this.provider, model : this.model, usageMissing : true }, 
                { threadId : this.#threadId, agentId : this.#agentId } 
            );
        }
    }

    #preflight(): void
    {
        this.#tracker.assertModelCallAllowed( {
            provider : this.provider,
            model    : this.model,
            baseUrl  : this.#baseUrl
        } );
    }

    #withAttemptObserver( request: ModelRequest ): ModelRequest
    {
        const prior = request.onAttempt;

        return {
            ...request,
            onAttempt : ( info ) => 
            {
                if( info.attempt > 1 )
                {
                    this.#tracker.recordSpendGap( 
                        `Retry attempt ${info.attempt}/${info.maxAttempts} for ${this.provider}:${this.model}`, 
                        {
                            provider    : this.provider,
                            model       : this.model,
                            attempt     : info.attempt,
                            maxAttempts : info.maxAttempts,
                            delayMs     : info.delayMs,
                            error       : info.error
                        }, 
                        { threadId : this.#threadId, agentId : this.#agentId } 
                    );
                }

                prior?.( info );
            }
        };
    }

    #recordResponse( response: ModelResponse ): void
    {
        if( response.usageMissing || !response.usage )
        {
            this.#tracker.recordSpendGap( 
                response.usageMissing 
                    ? `Vendor SDK returned no usage for ${this.provider}:${this.model}` 
                    : `Response missing usage for ${this.provider}:${this.model}`, 
                { provider : this.provider, model : this.model, usageMissing : true }, 
                { threadId : this.#threadId, agentId : this.#agentId } 
            );

            return;
        }

        this.#recordUsage( response.usage );
    }

    #recordUsage( usage: NonNullable<ModelResponse['usage']> ): void
    {
        const details = this.#tracker.record( this.model, usage, {
            provider : this.provider,
            baseUrl  : this.#baseUrl
        } );

        const span = this.#getSpan?.();

        if( span )
        {
            span.recordSpend( {
                category    : 'model',
                subcategory : this.model,
                costUSD     : details.totalCost,
                units       : usage.totalTokens,
                unitType    : 'tokens'
            } );
        }
    }
}

export function createMeteredModel( 
    inner: ModelProtocol, 
    options: MeteredModelOptions 
): MeteredModel
{
    return new MeteredModel( inner, options );
}
