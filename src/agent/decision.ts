import type { DecisionModel, DecisionQuestions, DecisionRequest, DecisionResponse } from '../core/decision.js';
import type { SpendTracker } from '../spend/tracker.js';
import { createMeteredDecisionModel } from '../providers/metered.js';
import type { ExecutionContext } from './context.js';
import { applyModelCallAttributes } from '../trace/genai.js';

export interface TracedDecisionOptions
{
    /** Meters spend and records it on the span, like language-model calls. */
    tracker?  : SpendTracker
    /** Span name; defaults to `model:decide`. */
    name?       : string
    attributes? : Record<string, string | number | boolean>
}

/**
 * Runs a decision call inside a `model` span so it appears in traces the way language-model calls do.
 * With a tracker, spend is metered (Jev: input tokens only) and attached to the span.
 */
export async function decideWithContext<Q extends DecisionQuestions>( 
    context: ExecutionContext, 
    model: DecisionModel, 
    request: DecisionRequest<Q>, 
    options: TracedDecisionOptions = {} 
): Promise<DecisionResponse<Q>>
{
    return context.withSpan( 
        options.name ?? 'model:decide', 
        async ( span ) => 
        {
            applyModelCallAttributes( span, { provider : model.provider, model : model.model } );
            span.setAttributes( options.attributes ?? {} );
            span.setAttribute( 'decision.questions', Object.keys( request.questions ).length );

            const metered = options.tracker 
                ? createMeteredDecisionModel( model, {
                    tracker  : options.tracker,
                    getSpan  : () => {return span;},
                    threadId : context.threadId,
                    agentId  : context.agentId
                } ) 
                : model;
            const response = await metered.decide( request );

            span.setAttribute( 'decision.calibrated', response.calibrated );

            applyModelCallAttributes( span, { provider : model.provider, model : model.model, response : { usage : response.usage } } );

            if( response.usage )
            {
                span.addMetrics( {
                    promptTokens     : response.usage.promptTokens,
                    completionTokens : response.usage.completionTokens
                } );
            }

            return response;
        }, 
        { kind : 'model' } 
    );
}
