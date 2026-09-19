export type SpendCategory = 
    | 'model'
    | 'storage'
    | 'compute'
    | 'network'
    | 'mcp'
    | 'tools'
    | 'custom';

export type StandardUnitType = 
    | 'bytes'
    | 'operations'
    | 'queries'
    | 'durationMs'
    | 'seconds'
    | 'records'
    | string;

export interface CategorySpendInput
{
    category     : SpendCategory
    subcategory? : string
    costUSD?     : number
    units?       : number
    unitType?    : StandardUnitType
    metadata?    : Record<string, unknown>
}

export interface CategorySpendRecord
{
    id           : string
    timestamp    : number
    category     : SpendCategory
    subcategory? : string
    costUSD      : number
    units?       : number
    unitType?    : StandardUnitType
    threadId?    : string
    agentId?     : string
    metadata?    : Record<string, unknown>
}

export type CategorySpendBreakdown = Record<SpendCategory, number>;
