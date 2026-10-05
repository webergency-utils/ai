import { OpenAIProviderAdapter } from './openai.js';
import type { ModelCapabilities, ModelConfig } from '../core/types.js';

export class GroqProviderAdapter extends OpenAIProviderAdapter
{
    constructor( config: ModelConfig )
    {
        super( 
            {
                ...config,
                provider : 'groq',
                baseUrl  : config.baseUrl ?? 'https://api.groq.com/openai/v1'
            } );
    }

    protected override get defaultEnvVar(): string
    {
        return 'GROQ_API_KEY';
    }

    protected override get defaultCapabilities(): ModelCapabilities
    {
        return {
            structuredOutput   : true,
            embeddings         : false,
            reasoningContent   : true,
            promptCacheControl : false,
            multimodal         : { image : true, audio : false, video : false, document : false }
        };
    }

    protected override get supportsPromptCacheKey(): boolean
    {
        return false;
    }
}
