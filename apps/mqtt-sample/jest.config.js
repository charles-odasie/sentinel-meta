/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  setupFiles: ['<rootDir>/test/setup.ts'],
  testTimeout: 15000,
  // Keep the suite honest: no forceExit, no open handles.
  detectOpenHandles: true,
};
