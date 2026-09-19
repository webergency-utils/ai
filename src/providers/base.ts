import type { ModelProtocol } from '../core/protocol.js';
import type { ModelConfig, ModelRequest, ModelResponse, ModelStreamChunk } from '../core/types.js';
import { ProviderError, RateLimitError } from '../core/error.js';

export abstract class BaseProviderAdapter implements ModelProtocol
{
    public readonly provider : string;
    public readonly model    : string;
    readonly #config         : ModelConfig;

    constructor( config: ModelConfig )
    {
        this.provider = config.provider;
        this.model = config.model;
        this.#config = config;
    }

    public get config(): ModelConfig
    {
        return this.#config;
    }

    public abstract generate( request: ModelRequest ): Promise<ModelResponse>;
    public abstract stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>;

    protected getApiKey( envVar?: string ): string
    {
        if( this.#config.apiKey )
        {
            return this.#config.apiKey;
        }

        if( envVar && typeof process !== 'undefined' && process.env && process.env[envVar] )
        {
            return process.env[envVar]!;
        }

        return '';
    }

    protected async handleErrorResponse( response: Response ): Promise<never>
    {
        let details: unknown;
        let errorMessage = `HTTP ${response.status} ${response.statusText}`;

        try
        {
            const text = await response.text();
            details = JSON.parse( text );

            if( details && typeof details === 'object' )
            {
                const record = details as Record<string, unknown>;
                const errorObj = ( record.error as Record<string, unknown> | undefined ) ?? record;
                errorMessage = ( errorObj.message as string | undefined ) ?? errorMessage;
            }
        }
        catch
        {
            // Non-JSON response
        }

        if( response.status === 429 )
        {
            const retryAfterHeader = response.headers.get( 'retry-after' );
            const retryAfter = retryAfterHeader ? parseInt( retryAfterHeader, 10 ) : undefined;

            throw new RateLimitError( this.provider, errorMessage, retryAfter, details );
        }

        throw new ProviderError( this.provider, errorMessage, response.status, details );
    }
}
