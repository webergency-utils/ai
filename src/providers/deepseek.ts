import { OpenAIProviderAdapter } from './openai.js';
import type { ModelConfig } from '../core/types.js';

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
}
