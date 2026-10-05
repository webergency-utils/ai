import { BaseTransport } from './base.js';
import type { ModelConfig, ModelRequest } from '../core/types.js';
import type { 
    ChoiceQuestion, 
    DecisionAnswers, 
    DecisionInputLimits, 
    DecisionModel, 
    DecisionQuestion, 
    DecisionQuestions, 
    DecisionRequest, 
    DecisionResponse 
} from '../core/decision.js';
import { 
    assertDecisionInputLimit, 
    assertDecisionRequest, 
    buildChoiceAnswer, 
    buildScoreAnswer, 
    buildYesNoAnswer, 
    toProbability 
} from '../core/decision.js';
import { InputLimitError, ProviderError } from '../core/error.js';

export const JEV_PROVIDER = 'typesafe';
export const JEV_DEFAULT_MODEL = 'jev-latest';
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';
/** Jev's documented budget: input data plus all questions. */
export const JEV_MAX_TOKENS = 64_000;
/** Jev's documented budget: input data plus the single longest question. */
export const JEV_MAX_CONTEXT_TOKENS = 32_000;

type WireQuestion = Record<string, unknown>;

interface WireAnswer
{
    type?          : string
    choice?        : string
    score?         : number
    noul?          : number
    confidence?    : number
    probabilities? : Record<string, number>
}

interface WireResponse
{
    model?   : string
    answers? : Record<string, WireAnswer>
    usage?   : { input_tokens? : number, output_tokens? : number }
}

export interface JevDecisionConfig extends Omit<ModelConfig, 'provider' | 'model'>
{
    provider? : string
    /** A pinned version or `jev-latest` (default). */
    model?    : string
    /** Overrides the documented input limits; pass `false` to disable the local pre-check. */
    inputLimits? : DecisionInputLimits | false
}

/** Translates a library question to Jev's wire format. Vendor names (`noul`) stay inside this adapter. */
export function toJevQuestion( question: DecisionQuestion ): WireQuestion
{
    const instructions = question.instructions ?? null;

    if( question.type === 'choice' )
    {
        return {
            type     : 'choice',
            instructions,
            criteria : Object.fromEntries( question.options.map( ( option ) => {return [ option.label, option.description ?? null ];} ) )
        };
    }

    if( question.type === 'score' )
    {
        return { type : 'score', instructions, criteria : [ ...question.levels ] };
    }

    const criteria = question.yes !== undefined || question.no !== undefined
        ? { ...( question.yes !== undefined ? { true : question.yes } : {} ), ...( question.no !== undefined ? { false : question.no } : {} ) }
        : undefined;

    return { type : 'noul', instructions, ...( criteria ? { criteria } : {} ) };
}

/**
 * Native HTTP adapter for TypeSafe's Jev (`POST /v1/systemone`).
 * Reuses the shared transport, so cancellation, timeouts, and retries match chat calls.
 * Jev's probabilities are calibrated, and its output tokens are free, so only input tokens cost.
 */
export class JevDecisionAdapter extends BaseTransport implements DecisionModel
{
    readonly #baseUrl : string;
    readonly #limits  : DecisionInputLimits | false;

    constructor( config: JevDecisionConfig = {} )
    {
        super( { ...config, provider : JEV_PROVIDER, model : config.model || JEV_DEFAULT_MODEL } );
        const rawBase = config.baseUrl ?? JEV_DEFAULT_BASE_URL;
        let end = rawBase.length;

        while( end > 0 && rawBase.charCodeAt( end - 1 ) === 47 /* '/' */ )
        {
            end -= 1;
        }

        this.#baseUrl = rawBase.slice( 0, end );
        this.#limits = config.inputLimits ?? { maxTokens : JEV_MAX_TOKENS, maxContextTokens : JEV_MAX_CONTEXT_TOKENS };
    }

    public async decide<Q extends DecisionQuestions>( request: DecisionRequest<Q> ): Promise<DecisionResponse<Q>>
    {
        assertDecisionRequest( request );

        if( this.#limits )
        {
            assertDecisionInputLimit( this.provider, request, this.#limits );
        }

        const apiKey = this.getApiKey( 'TYPESAFE_API_KEY' );

        if( !apiKey )
        {
            throw new ProviderError( this.provider, 'Missing API key: pass apiKey or set TYPESAFE_API_KEY', 401 );
        }

        const names = Object.keys( request.questions );
        const body = 
            {
                model     : this.model,
                state     : request.input,
                questions : Object.fromEntries( names.map( ( name ) => {return [ name, toJevQuestion( request.questions[ name ] ) ];} ) )
            };

        let response: Response;

        try
        {
            response = await this.request( {
                url  : `${this.#baseUrl}/v1/systemone`,
                init : {
                    method  : 'POST',
                    headers : {
                        'Content-Type'  : 'application/json',
                        'Authorization' : `Bearer ${apiKey}`
                    },
                    body : JSON.stringify( body )
                },
                ...this.resolveTransportOptions( request as unknown as ModelRequest )
            } );
        }
        catch( error )
        {
            if( error instanceof ProviderError && error.statusCode === 413 )
            {
                throw new InputLimitError( this.provider, 'server rejected the request as too large', undefined, undefined, error.details );
            }

            throw error;
        }

        const data = await response.json() as WireResponse;
        const answers = this.#parseAnswers( request.questions, data );
        const usage = data.usage;

        return {
            answers,
            calibrated : true,
            model      : data.model ?? this.model,
            raw        : data,
            ...( usage && typeof usage.input_tokens === 'number'
                ? {
                    usage : {
                        promptTokens     : usage.input_tokens,
                        completionTokens : usage.output_tokens ?? 0,
                        totalTokens      : usage.input_tokens + ( usage.output_tokens ?? 0 ),
                        raw              : usage as Record<string, unknown>
                    }
                }
                : { usageMissing : true as const } )
        };
    }

    #parseAnswers<Q extends DecisionQuestions>( questions: Q, data: WireResponse ): DecisionAnswers<Q>
    {
        if( !data || typeof data.answers !== 'object' || data.answers === null )
        {
            throw new ProviderError( this.provider, 'Response has no answers object', 502, data );
        }

        const out: Record<string, unknown> = {};

        for( const [ name, question ] of Object.entries( questions ) )
        {
            const wire = data.answers[ name ];

            if( !wire || typeof wire !== 'object' )
            {
                throw new ProviderError( this.provider, `Response has no answer for question '${name}'`, 502, data );
            }

            out[ name ] = this.#parseAnswer( name, question, wire );
        }

        return out as DecisionAnswers<Q>;
    }

    #parseAnswer( name: string, question: DecisionQuestion, wire: WireAnswer ): unknown
    {
        const expected = question.type === 'yesNo' ? 'noul' : question.type;

        if( wire.type !== expected )
        {
            throw new ProviderError( this.provider, `Answer '${name}' has type '${String( wire.type )}', expected '${expected}'`, 502, wire );
        }

        if( question.type === 'yesNo' )
        {
            return buildYesNoAnswer( toProbability( this.provider, `Answer '${name}' noul`, wire.noul ) );
        }

        const confidence = toProbability( this.provider, `Answer '${name}' confidence`, wire.confidence );
        const probabilities = wire.probabilities;

        if( !probabilities || typeof probabilities !== 'object' )
        {
            throw new ProviderError( this.provider, `Answer '${name}' has no probabilities`, 502, wire );
        }

        if( question.type === 'choice' )
        {
            return this.#parseChoice( name, question, wire, probabilities, confidence );
        }

        const vector = question.levels.map( ( _level, index ) => 
        {
            return toProbability( this.provider, `Answer '${name}' level ${index} probability`, probabilities[ String( index ) ] );
        } );

        if( typeof wire.score !== 'number' || !Number.isFinite( wire.score ) )
        {
            throw new ProviderError( this.provider, `Answer '${name}' has no numeric score`, 502, wire );
        }

        return buildScoreAnswer( vector, confidence, wire.score );
    }

    #parseChoice( 
        name: string, 
        question: ChoiceQuestion, 
        wire: WireAnswer, 
        probabilities: Record<string, number>, 
        confidence: number 
    ): unknown
    {
        const labels = question.options.map( ( option ) => {return option.label;} );

        if( typeof wire.choice !== 'string' || !labels.includes( wire.choice ) )
        {
            throw new ProviderError( this.provider, `Answer '${name}' chose '${String( wire.choice )}', which is not a declared label`, 502, wire );
        }

        const vector = labels.map( ( label ) => 
        {
            return toProbability( this.provider, `Answer '${name}' probability for '${label}'`, probabilities[ label ] );
        } );

        return buildChoiceAnswer( question, vector, confidence, wire.choice );
    }
}
