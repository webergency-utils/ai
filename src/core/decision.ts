import type { ModelRequestAttemptInfo, UsageMetrics } from './types.js';
import { InputLimitError, InvalidInputError, ProviderError } from './error.js';

/** Text, a structured object, or a list. Sent to the decision model as the data every question refers to. */
export type DecisionInput = string | Record<string, unknown> | unknown[];

/** The question itself. Plain text, or a structured object / list for long questions that reference data by name. */
export type DecisionInstructions = string | Record<string, unknown> | unknown[];

export const MAX_CHOICE_LABELS = 255;
export const MIN_SCORE_LEVELS = 2;
export const MAX_SCORE_LEVELS = 10;

export interface ChoiceOption<L extends string = string>
{
    readonly label        : L
    readonly description? : DecisionInstructions
}

/** One label from a named set of up to 255 labels, each optionally described. */
export interface ChoiceQuestion<L extends string = string>
{
    readonly type          : 'choice'
    readonly options       : ReadonlyArray<ChoiceOption<L>>
    readonly instructions? : DecisionInstructions
}

/** A position on an ordered scale of 2 to 10 described levels (level 0 is the lowest). */
export interface ScoreQuestion
{
    readonly type          : 'score'
    readonly levels        : ReadonlyArray<DecisionInstructions | null>
    readonly instructions? : DecisionInstructions
}

/** The probability that the answer is yes, with optional descriptions of what yes and no mean. */
export interface YesNoQuestion
{
    readonly type          : 'yesNo'
    readonly yes?          : DecisionInstructions
    readonly no?           : DecisionInstructions
    readonly instructions? : DecisionInstructions
}

export type DecisionQuestion = ChoiceQuestion<string> | ScoreQuestion | YesNoQuestion;

export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface ChoiceAnswer<L extends string = string>
{
    readonly type          : 'choice'
    /** The highest-probability label. */
    readonly value         : L
    readonly probabilities : Readonly<Record<L, number>>
    readonly confidence    : number
}

export interface ScoreAnswer
{
    readonly type          : 'score'
    /** Probability-weighted level; may fall between integer levels. */
    readonly value         : number
    /** One probability per level, indexed by level. */
    readonly probabilities : readonly number[]
    readonly confidence    : number
}

export interface YesNoAnswer
{
    readonly type        : 'yesNo'
    /** Probability that the answer is yes (0 to 1). */
    readonly value       : number
    /** Same number as `value`, named for readability at call sites. */
    readonly probability : number
}

export type DecisionAnswer<Q extends DecisionQuestion> =
    Q extends ChoiceQuestion<infer L> ? ChoiceAnswer<L>
        : Q extends ScoreQuestion ? ScoreAnswer
            : Q extends YesNoQuestion ? YesNoAnswer
                : never;

export type DecisionAnswers<Q extends DecisionQuestions> =
    {
        readonly [K in keyof Q] : DecisionAnswer<Q[K]>
    };

export interface DecisionOptions
{
    signal?    : AbortSignal
    timeoutMs? : number
    /** false disables retries; object overrides maxRetries for this call */
    retry?     : false | { maxRetries? : number }
    onAttempt? : ( info: ModelRequestAttemptInfo ) => void
}

export interface DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> extends DecisionOptions
{
    input     : DecisionInput
    questions : Q
}

export interface DecisionResponse<Q extends DecisionQuestions = DecisionQuestions>
{
    answers       : DecisionAnswers<Q>
    /** True when probabilities are calibrated by the model (Jev); false for self-reported ones. */
    calibrated    : boolean
    /** The model version that answered (may differ from the requested alias). */
    model         : string
    usage?        : UsageMetrics
    /** True when the model returned no usage; metering records a gap, never zero cost. */
    usageMissing? : true
    raw           : unknown
}

/** Second model class beside {@link LanguageModel}: typed questions in, typed answers with probabilities out. */
export interface DecisionModel
{
    readonly provider : string
    readonly model    : string

    decide<Q extends DecisionQuestions>( request: DecisionRequest<Q> ): Promise<DecisionResponse<Q>>
}

function assertDescription( where: string, value: unknown ): void
{
    if( value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'object' )
    {
        throw new InvalidInputError( `${where} must be a string, object, or array` );
    }
}

/**
 * Question builders. Names follow the library's vocabulary; vendor wire names
 * (for example Jev's `noul`) are translated inside the vendor adapter.
 */
export const question = 
    {
        /**
         * One label from a named set. Pass a list of labels, or a record of label to description.
         * Answer values are typed as the union of the labels.
         */
        choice<const L extends string>( 
            labels: readonly L[] | Readonly<Record<L, DecisionInstructions | null | undefined>>, 
            options: { instructions? : DecisionInstructions } = {} 
        ): ChoiceQuestion<L>
        {
            const entries: ChoiceOption<L>[] = Array.isArray( labels )
                ? ( labels as readonly L[] ).map( ( label ) => {return { label };} )
                : Object.entries( labels as Record<string, DecisionInstructions | null | undefined> ).map( ( [ label, description ] ) => 
                {
                    return description === undefined || description === null 
                        ? { label : label as L } 
                        : { label : label as L, description };
                } );

            const built: ChoiceQuestion<L> = 
                {
                    type    : 'choice',
                    options : entries,
                    ...( options.instructions !== undefined ? { instructions : options.instructions } : {} )
                };

            assertQuestion( 'choice', built );

            return built;
        },

        /** A position on an ordered scale. `levels` are descriptions indexed from 0 (lowest). */
        score( 
            levels: ReadonlyArray<DecisionInstructions | null>, 
            options: { instructions? : DecisionInstructions } = {} 
        ): ScoreQuestion
        {
            const built: ScoreQuestion = 
                {
                    type   : 'score',
                    levels : [ ...levels ],
                    ...( options.instructions !== undefined ? { instructions : options.instructions } : {} )
                };

            assertQuestion( 'score', built );

            return built;
        },

        /** The probability that something is true. Optionally describe what yes and no mean. */
        yesNo( options: { instructions? : DecisionInstructions, yes? : DecisionInstructions, no? : DecisionInstructions } = {} ): YesNoQuestion
        {
            const built: YesNoQuestion = 
                {
                    type : 'yesNo',
                    ...( options.instructions !== undefined ? { instructions : options.instructions } : {} ),
                    ...( options.yes !== undefined ? { yes : options.yes } : {} ),
                    ...( options.no !== undefined ? { no : options.no } : {} )
                };

            assertQuestion( 'yesNo', built );

            return built;
        }
    };

/** Validates one question's shape; builders call it and adapters re-run it for hand-written questions. */
export function assertQuestion( name: string, candidate: unknown ): asserts candidate is DecisionQuestion
{
    if( !candidate || typeof candidate !== 'object' )
    {
        throw new InvalidInputError( `Question '${name}' must be an object built with question.choice/score/yesNo` );
    }

    const q = candidate as Record<string, unknown>;

    assertDescription( `Question '${name}' instructions`, q.instructions );

    if( q.type === 'choice' )
    {
        const options = q.options;

        if( !Array.isArray( options ) || options.length < 1 || options.length > MAX_CHOICE_LABELS )
        {
            throw new InvalidInputError( `Choice question '${name}' needs 1 to ${MAX_CHOICE_LABELS} labels` );
        }

        const seen = new Set<string>();

        for( const option of options as Array<Record<string, unknown>> )
        {
            if( !option || typeof option.label !== 'string' || option.label === '' )
            {
                throw new InvalidInputError( `Choice question '${name}' labels must be non-empty strings` );
            }

            if( seen.has( option.label ) )
            {
                throw new InvalidInputError( `Choice question '${name}' has duplicate label '${option.label}'` );
            }

            seen.add( option.label );
            assertDescription( `Choice question '${name}' label '${option.label}' description`, option.description );
        }

        return;
    }

    if( q.type === 'score' )
    {
        const levels = q.levels;

        if( !Array.isArray( levels ) || levels.length < MIN_SCORE_LEVELS || levels.length > MAX_SCORE_LEVELS )
        {
            throw new InvalidInputError( `Score question '${name}' needs ${MIN_SCORE_LEVELS} to ${MAX_SCORE_LEVELS} levels` );
        }

        levels.forEach( ( level, index ) => {assertDescription( `Score question '${name}' level ${index}`, level );} );

        return;
    }

    if( q.type === 'yesNo' )
    {
        assertDescription( `Yes/no question '${name}' yes`, q.yes );
        assertDescription( `Yes/no question '${name}' no`, q.no );

        return;
    }

    throw new InvalidInputError( `Question '${name}' has unknown type '${String( q.type )}'` );
}

/** Validates a whole decision request before any HTTP or model call. */
export function assertDecisionRequest( request: DecisionRequest ): void
{
    const input = request?.input as unknown;

    if( input === undefined || input === null || ( typeof input !== 'string' && typeof input !== 'object' ) )
    {
        throw new InvalidInputError( 'decide() input must be text, an object, or a list' );
    }

    const questions = request.questions as unknown;

    if( !questions || typeof questions !== 'object' || Array.isArray( questions ) )
    {
        throw new InvalidInputError( 'decide() questions must be an object of named questions' );
    }

    const names = Object.keys( questions );

    if( names.length === 0 )
    {
        throw new InvalidInputError( 'decide() requires at least one question' );
    }

    for( const name of names )
    {
        assertQuestion( name, ( questions as Record<string, unknown> )[ name ] );
    }
}

export interface DecisionInputLimits
{
    /** Input data plus all questions. */
    maxTokens?        : number
    /** Input data plus the single longest question. */
    maxContextTokens? : number
    /** Token estimator; defaults to roughly four characters per token. */
    estimateTokens?   : ( text: string ) => number
}

export function estimateTextTokens( text: string ): number
{
    return Math.ceil( text.length / 4 );
}

function questionText( question: DecisionQuestion ): string
{
    return JSON.stringify( question );
}

export function estimateDecisionTokens( 
    request: Pick<DecisionRequest, 'input' | 'questions'>, 
    estimate: ( text: string ) => number = estimateTextTokens 
): { total : number, withLongestQuestion : number }
{
    const state = estimate( typeof request.input === 'string' ? request.input : JSON.stringify( request.input ) );
    const sizes = Object.values( request.questions ).map( ( q ) => {return estimate( questionText( q ) );} );

    return {
        total               : state + sizes.reduce( ( sum, size ) => {return sum + size;}, 0 ),
        withLongestQuestion : state + Math.max( 0, ...sizes )
    };
}

/** Fails with {@link InputLimitError}; the library never truncates input to make it fit. */
export function assertDecisionInputLimit( 
    provider: string, 
    request: Pick<DecisionRequest, 'input' | 'questions'>, 
    limits: DecisionInputLimits 
): void
{
    if( limits.maxTokens === undefined && limits.maxContextTokens === undefined )
    {
        return;
    }

    const estimate = estimateDecisionTokens( request, limits.estimateTokens );

    if( limits.maxTokens !== undefined && estimate.total > limits.maxTokens )
    {
        throw new InputLimitError( provider, 'input and questions', estimate.total, limits.maxTokens );
    }

    if( limits.maxContextTokens !== undefined && estimate.withLongestQuestion > limits.maxContextTokens )
    {
        throw new InputLimitError( provider, 'input and longest question', estimate.withLongestQuestion, limits.maxContextTokens );
    }
}

const PROBABILITY_EPSILON = 1e-6;

/** Accepts a finite probability, tolerating float noise just outside [0, 1]; anything else is a provider defect. */
export function toProbability( provider: string, where: string, value: unknown ): number
{
    if( typeof value !== 'number' || !Number.isFinite( value ) || value < -PROBABILITY_EPSILON || value > 1 + PROBABILITY_EPSILON )
    {
        throw new ProviderError( provider, `${where} is not a probability between 0 and 1 (got ${String( value )})`, 502, { value } );
    }

    return Math.min( 1, Math.max( 0, value ) );
}

/** Rescales self-reported probabilities to sum to 1. Rejects an all-zero vector. */
export function normalizeProbabilities( provider: string, where: string, values: number[] ): number[]
{
    const sum = values.reduce( ( total, value ) => {return total + value;}, 0 );

    if( !( sum > 0 ) )
    {
        throw new ProviderError( provider, `${where} probabilities sum to zero`, 502, { values } );
    }

    return values.map( ( value ) => {return value / sum;} );
}

export function argmax( values: readonly number[] ): number
{
    let best = 0;

    for( let i = 1; i < values.length; i++ )
    {
        if( values[ i ] > values[ best ] )
        {
            best = i;
        }
    }

    return best;
}

export function weightedLevel( probabilities: readonly number[] ): number
{
    return probabilities.reduce( ( total, probability, level ) => {return total + probability * level;}, 0 );
}

export function buildChoiceAnswer<L extends string>( 
    question: ChoiceQuestion<L>, 
    probabilities: readonly number[], 
    confidence: number, 
    value?: L 
): ChoiceAnswer<L>
{
    const record = Object.fromEntries( 
        question.options.map( ( option, index ) => {return [ option.label, probabilities[ index ] ];} ) 
    ) as Record<L, number>;

    return {
        type          : 'choice',
        value         : value ?? question.options[ argmax( probabilities ) ].label,
        probabilities : record,
        confidence
    };
}

export function buildScoreAnswer( probabilities: readonly number[], confidence: number, value?: number ): ScoreAnswer
{
    return {
        type          : 'score',
        value         : value ?? weightedLevel( probabilities ),
        probabilities : [ ...probabilities ],
        confidence
    };
}

export function buildYesNoAnswer( probability: number ): YesNoAnswer
{
    return { type : 'yesNo', value : probability, probability };
}
