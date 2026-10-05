import { BaseTransport } from './base.js';
import type { EmbeddingOptions, EmbeddingProtocol, EmbeddingResponse } from '../core/embeddings.js';
import type { ModelRequest } from '../core/types.js';
import { normalizeEmbeddingInput } from '../core/embeddings.js';

/**
 * Base for native HTTP embedding adapters. Reuses the chat transport
 * (signal, timeout, retry) so embeddings behave like every other provider call.
 */
export abstract class BaseEmbeddingAdapter extends BaseTransport implements EmbeddingProtocol
{
    public async embed( input: string | string[], options: EmbeddingOptions = {} ): Promise<EmbeddingResponse>
    {
        return this.embedBatch( normalizeEmbeddingInput( input ), options );
    }

    protected abstract embedBatch( inputs: string[], options: EmbeddingOptions ): Promise<EmbeddingResponse>;

    protected embeddingTransport( options: EmbeddingOptions ): ReturnType<BaseTransport['resolveTransportOptions']>
    {
        return this.resolveTransportOptions( options as ModelRequest );
    }
}
