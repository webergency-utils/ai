import { defineConfig } from 'vitest/config';

export default defineConfig(
{
    test : 
    {
        globals     : true,
        environment : 'node',
        include     : ['tests/**/*.test.ts'],
        // Live provider suites hit real APIs; they only run via `npm run test:live` (vitest.live.config.ts).
        exclude     : ['**/node_modules/**', '**/dist/**', 'tests/live/**'],
        coverage    :
        {
            provider       : 'v8',
            reportsDirectory : './coverage',
            reporter       : ['text-summary', 'text', 'lcov', 'json-summary'],
            include        : ['src/**/*.ts'],
            // Only barrels and type-only modules are excluded; everything else is measured.
            exclude        : ['src/**/index.ts', 'src/**/*.d.ts', 'src/**/types.ts'],
            // Measured baseline (2026-10-06): lines/statements 92.3, branches 88.5, functions 94.9.
            // Thresholds sit ~2 points below it; ratchet upward only.
            thresholds     :
            {
                lines      : 90,
                statements : 90,
                branches   : 86,
                functions  : 92
            }
        }
    }
});
