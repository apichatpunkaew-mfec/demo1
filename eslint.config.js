// ESLint v9 flat config — security-focused
const security = require('eslint-plugin-security');

module.exports = [
  {
    ignores: ['node_modules/**', 'public/app.js'], // public/app.js is browser ESM
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
      },
    },
    plugins: { security },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
      // Security plugin rules — focus on real issues, not noise
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-unsafe-regex': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-child-process': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-pseudoRandomBytes': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-no-csrf-before-method-override': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-disable-mustache-escape': 'warn',
    },
  },
];
