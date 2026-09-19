import type { ModelRequest, ModelResponse, ModelStreamChunk } from './types.js';

export interface ModelProtocol
{
    readonly provider : string
    readonly model    : string

    generate( request: ModelRequest ): Promise<ModelResponse>
    stream( request: ModelRequest ): AsyncIterable<ModelStreamChunk>
}
