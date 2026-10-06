import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
    {
        ignores: ['**/dist/**', '**/node_modules/**', '**/build/**']
    },
    {
        files: ['src/**/*.ts', 'tests/**/*.ts'],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended
        ],
        plugins: {
            '@stylistic': stylistic
        },
        rules: {
            '@stylistic/indent': ['error', 4],
            'indent': 'off',
            'quotes': ['error', 'single', { 'avoidEscape': true }],
            '@stylistic/brace-style': ['error', 'allman', { 'allowSingleLine': true }],
            'brace-style': 'off',
            'space-in-parens': ['error', 'always', { 'exceptions': ['empty'] }],
            'key-spacing': ['error', {
                'align': 'colon',
                'beforeColon': true,
                'afterColon': true
            }],
            'block-spacing': ['error', 'never'],
            '@typescript-eslint/ban-ts-comment': ['error', {
                'ts-expect-error': 'allow-with-description',
                'ts-ignore': 'allow-with-description',
                'ts-nocheck': true,
                'minimumDescriptionLength': 10
            }],
            '@typescript-eslint/no-unused-vars': ['error', {
                'argsIgnorePattern': '^_',
                'varsIgnorePattern': '^_',
                'caughtErrorsIgnorePattern': '^_'
            }],
            'semi': ['error', 'always'],
            'comma-dangle': ['error', 'never'],
            '@stylistic/member-delimiter-style': ['error', {
                'multiline': {
                    'delimiter': 'none',
                    'requireLast': false
                },
                'singleline': {
                    'delimiter': 'comma',
                    'requireLast': false
                }
            }],
            'keyword-spacing': ['error', { 
                'overrides': {
                    'if': { 'after': false },
                    'for': { 'after': false },
                    'while': { 'after': false },
                    'catch': { 'after': false }
                }
            }]
        }
    },
    {
        // Tests deliberately reach into private state and build partial mocks (fake fetch
        // responses, internal wire payloads); typing those precisely adds noise, not safety.
        // Production code under src/** keeps the rule enabled.
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off'
        }
    }
);
