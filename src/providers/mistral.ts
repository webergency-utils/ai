import { OpenAIProviderAdapter } from './openai.js';
import type { ModelCapabilities, ModelConfig } from '../core/types.js';

export class MistralProviderAdapter extends OpenAIProviderAdapter
{
    constructor( config: ModelConfig )
    {
        super( {
            ...config,
            provider : 'mistral',
            baseUrl  : config.baseUrl ?? 'https://api.mistral.ai/v1'
        } );
    }

    protected override get defaultEnvVar(): string
    {
        return 'MISTRAL_API_KEY';
    }

    protected override get defaultCapabilities(): ModelCapabilities
    {
        return {
            structuredOutput   : true,
            embeddings         : false,
            reasoningContent   : false,
            promptCacheControl : false,
            multimodal         : { image : true, audio : false, video : false, document : false }
        };
    }

    protected override get supportsPromptCacheKey(): boolean
    {
        return false;
    }
}
