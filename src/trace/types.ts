import type { CategorySpendBreakdown, CategorySpendInput } from '../spend/types.js';

export type SpanKind = 
    | 'agent'
    | 'model'
    | 'tool'
    | 'storage'
    | 'mcp'
    | 'custom';

export type SpanStatus = 'ok' | 'error';

export interface SpanErrorDetails
{
    message : string
    name?   : string
    stack?  : string
}

export type SpanAttributeValue = string | number | boolean;

export interface SpanMetrics
{
    promptTokens?     : number
    completionTokens? : number
    cachedTokens?     : number
    reasoningTokens?  : number
    bytes?            : number
    records?          : number
    operations?       : number
    subcallCount?     : number
    [key: string]     : number | undefined
}

export interface SpanRollup
{
    totalDurationMs : number
    totalSpendUSD   : number
    categorySpend   : CategorySpendBreakdown
    metrics         : SpanMetrics
}

export interface SpanOptions
{
    parentSpanId? : string
    kind?         : SpanKind
    attributes?   : Record<string, SpanAttributeValue>
    metrics?      : SpanMetrics
    startTime?    : number
}

export interface SerializedSpan
{
    id             : string
    traceId        : string
    parentSpanId?  : string
    name           : string
    kind           : SpanKind
    startTime      : number
    endTime?       : number
    durationMs?    : number
    status         : SpanStatus
    errorDetails?  : SpanErrorDetails
    attributes     : Record<string, SpanAttributeValue>
    metrics        : SpanMetrics
    spendUSD       : number
    categorySpend  : CategorySpendBreakdown
    children       : SerializedSpan[]
    rollup?        : SpanRollup
}

export interface Span
{
    readonly id            : string
    readonly traceId       : string
    readonly parentSpanId? : string
    readonly name          : string
    readonly kind          : SpanKind
    readonly startTime     : number
    endTime?               : number
    durationMs?            : number
    status                 : SpanStatus
    errorDetails?          : SpanErrorDetails
    readonly attributes    : Record<string, SpanAttributeValue>
    readonly metrics       : SpanMetrics
    spendUSD               : number
    readonly categorySpend : CategorySpendBreakdown
    readonly children      : Span[]
    rollup?                : SpanRollup

    setAttribute( key: string, value: SpanAttributeValue ): void
    setAttributes( attributes: Record<string, SpanAttributeValue> ): void
    recordMetric( key: string, value: number ): void
    addMetrics( metrics: Partial<SpanMetrics> ): void
    recordSpend( entry: CategorySpendInput ): void
    addChild( child: Span ): void
    end( endTime?: number ): void
    toJSON(): SerializedSpan
}

export interface Trace
{
    traceId        : string
    threadId?      : string
    agentId?       : string
    startTime      : number
    endTime?       : number
    durationMs?    : number
    rootSpan       : Span
    totalSpendUSD  : number
    categorySpend  : CategorySpendBreakdown
}

export interface SerializedTrace
{
    traceId        : string
    threadId?      : string
    agentId?       : string
    startTime      : number
    endTime?       : number
    durationMs?    : number
    rootSpan       : SerializedSpan
    totalSpendUSD  : number
    categorySpend  : CategorySpendBreakdown
}

export interface TraceFilterOptions
{
    threadId?   : string
    agentId?    : string
    status?     : SpanStatus
    minDuration?: number
    since?      : number
    until?      : number
    limit?      : number
}

export interface TraceEvents
{
    'span:start'    : ( span: Span ) => void
    'span:end'      : ( span: Span ) => void
    'trace:complete': ( trace: Trace ) => void
}
