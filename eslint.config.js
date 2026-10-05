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
    }
);
