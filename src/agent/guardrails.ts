import { GuardrailTripwireError, type GuardrailStage } from '../core/error.js';
import type { ChatMessage } from '../core/types.js';
import type { ExecutionContext } from './context.js';

export type GuardrailVerdict =
    | { allow : true }
    | { allow : false, reason : string, tripwire? : boolean };

export interface GuardrailContext
{
    stage    : GuardrailStage
    threadId : string
    runId    : string
    agentId  : string
    context  : ExecutionContext
    signal   : AbortSignal
}

export type Guardrail<TPayload> = 
    ( payload: TPayload, ctx: GuardrailContext ) => Promise<GuardrailVerdict> | GuardrailVerdict;

export interface InputGuardrailPayload
{
    /** Messages this run appended to the conversation (the new user input). */
    messages : ChatMessage[]
}

export interface ToolCallGuardrailPayload
{
    id        : string
    name      : string
    arguments : Record<string, unknown>
}

export interface ToolResultGuardrailPayload extends ToolCallGuardrailPayload
{
    /** The text the model would see. */
    result : string
}

export interface OutputGuardrailPayload
{
    text    : string
    /** Validated structured value when the agent has an `outputSchema`. */
    output? : unknown
}

export interface AgentGuardrails
{
    input?      : Guardrail<InputGuardrailPayload>[]
    toolCall?   : Guardrail<ToolCallGuardrailPayload>[]
    toolResult? : Guardrail<ToolResultGuardrailPayload>[]
    output?     : Guardrail<OutputGuardrailPayload>[]
}

const STAGES: GuardrailStage[] = [ 'input', 'toolCall', 'toolResult', 'output' ];

/** Throws on anything that is not an object of arrays of functions keyed by a known stage. */
export function assertGuardrailConfig( guardrails: AgentGuardrails ): void
{
    for( const key of Object.keys( guardrails ) )
    {
        if( !STAGES.includes( key as GuardrailStage ) )
        {
            throw new TypeError( `Unknown guardrail stage '${key}'; expected one of ${STAGES.join( ', ' )}` );
        }

        const list = guardrails[ key as GuardrailStage ] as unknown;

        if( list !== undefined && ( !Array.isArray( list ) || list.some( ( fn ) => {return typeof fn !== 'function';} ) ) )
        {
            throw new TypeError( `guardrails.${key} must be an array of functions` );
        }
    }
}

/**
 * Evaluates guardrails in order; the first deny wins. Fails closed: a guardrail that throws,
 * or returns something that is not a valid verdict, raises a `GuardrailTripwireError`.
 */
export async function runGuardrails<TPayload>( 
    stage: GuardrailStage, 
    guardrails: Guardrail<TPayload>[] | undefined, 
    payload: TPayload, 
    ctx: Omit<GuardrailContext, 'stage'> 
): Promise<GuardrailVerdict>
{
    if( !guardrails || guardrails.length === 0 )
    {
        return { allow : true };
    }

    return ctx.context.withSpan( 
        `guardrail:${stage}`, 
        async ( span ) => 
        {
            let verdict: GuardrailVerdict = { allow : true };

            for( const guardrail of guardrails )
            {
                let result: unknown;

                try
                {
                    result = await guardrail( payload, { ...ctx, stage } );
                }
                catch( error )
                {
                    throw new GuardrailTripwireError( 
                        stage, 
                        `guardrail threw: ${error instanceof Error ? error.message : String( error )}`, 
                        error 
                    );
                }

                const candidate = result as Partial<{ allow : unknown, reason : unknown }> | null | undefined;

                if( !candidate || typeof candidate !== 'object' || typeof candidate.allow !== 'boolean' )
                {
                    throw new GuardrailTripwireError( stage, `guardrail returned an invalid verdict: ${JSON.stringify( result ) ?? String( result )}` );
                }

                if( !candidate.allow )
                {
                    if( typeof candidate.reason !== 'string' || candidate.reason === '' )
                    {
                        throw new GuardrailTripwireError( stage, 'guardrail denied without a reason' );
                    }

                    verdict = result as GuardrailVerdict;

                    break;
                }
            }

            span.setAttribute( 'guardrail.allowed', verdict.allow );

            if( !verdict.allow )
            {
                span.setAttribute( 'guardrail.reason', verdict.reason );
            }

            return verdict;
        }, 
        { kind : 'custom', attributes : { 'guardrail.stage' : stage } } 
    );
}
