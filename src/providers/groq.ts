import { OpenAIProviderAdapter } from './openai.js';
import type { ModelConfig } from '../core/types.js';

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
}
