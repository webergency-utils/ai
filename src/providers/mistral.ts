import { OpenAIProviderAdapter } from './openai.js';
import type { ModelConfig } from '../core/types.js';

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
}
