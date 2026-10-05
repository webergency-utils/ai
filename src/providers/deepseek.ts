import { OpenAIProviderAdapter } from './openai.js';
import type { ModelCapabilities, ModelConfig } from '../core/types.js';

export class DeepSeekProviderAdapter extends OpenAIProviderAdapter
{
    constructor( config: ModelConfig )
    {
        super( {
            ...config,
            provider : 'deepseek',
            baseUrl  : config.baseUrl ?? 'https://api.deepseek.com'
        } );
    }

    protected override get defaultEnvVar(): string
    {
        return 'DEEPSEEK_API_KEY';
    }

    protected override get structuredWireFormat(): 'json_schema' | 'json_object'
    {
        return 'json_object';
    }

    protected override get defaultCapabilities(): ModelCapabilities
    {
        return {
            structuredOutput   : true,
            embeddings         : false,
            reasoningContent   : true,
            promptCacheControl : false,
            multimodal         : { image : false, audio : false, video : false, document : false }
        };
    }

    protected override get supportsPromptCacheKey(): boolean
    {
        return false;
    }
}
