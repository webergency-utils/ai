import type { ModelCapabilities, ModelRequest, ModelResponse, ModelStreamChunk } from './types.js';

export interface LanguageModel
{
    readonly provider      : string
    readonly model         : string
    /** Absent on minimal custom models; treat as {@link NO_CAPABILITIES}. */
    readonly capabilities? : ModelCapabilities

    generate( request: ModelRequest ): Promise<ModelResponse>
    stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
}

/** Alias kept for existing imports; new code should use {@link LanguageModel}. */
export type ModelProtocol = LanguageModel;

export const NO_CAPABILITIES: ModelCapabilities = Object.freeze(
    {
        structuredOutput   : false,
        embeddings         : false,
        reasoningContent   : false,
        promptCacheControl : false,
        multimodal         : Object.freeze( { image : false, audio : false, video : false, document : false } )
    } ) as ModelCapabilities;

export function getCapabilities( model: LanguageModel ): ModelCapabilities
{
    return model.capabilities ?? NO_CAPABILITIES;
}
