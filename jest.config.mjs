const isWindows = process.platform === 'win32';
const timeoutMult = parseInt(process.env.WIN_TEST_TIMEOUT_MULT ?? '1', 10);

export default {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.mjs'],
  testTimeout: 30_000 * timeoutMult,
  workerIdleMemoryLimit: isWindows ? '512MB' : undefined,
  collectCoverageFrom: ['hooks/**/*.mjs', 'lib/**/*.mjs', '!**/*.test.*'],
  coverageReporters: ['text', 'json-summary', 'lcov'],
  coverageThreshold: {
    './hooks/': { statements: 100, branches: 100, functions: 100, lines: 100 },
    './lib/': { statements: 90 },
  },
};
