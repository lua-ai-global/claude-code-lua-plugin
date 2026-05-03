module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.mjs'],
  collectCoverageFrom: ['src/**/*.mjs', '!src/**/*.test.*'],
  coverageThreshold: {
    './src/': { statements: 80 },
  },
};
