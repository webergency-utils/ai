import { defineConfig } from 'vitest/config';

// Opt-in suite against real providers: `AI_LIVE=1 npm run test:live`. Never part of `npm test` or CI.
export default defineConfig(
{
    test :
    {
        globals     : true,
        environment : 'node',
        include     : ['tests/live/**/*.live.test.ts'],
        testTimeout : 90_000,
        hookTimeout : 30_000,
        // Providers are rate limited; run files and cases one at a time.
        fileParallelism : false,
        sequence    : { concurrent : false }
    }
});
