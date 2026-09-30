const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'logs/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs', // ESLint sẽ hiểu code là const express = require('express'); chứ không phải ES Module.
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Code style
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      indent: ['error', 2],

      // Common JavaScript errors
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
        },
      ],
      'no-undef': 'error',
      eqeqeq: ['error', 'always'],
      // Code quality
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
];
