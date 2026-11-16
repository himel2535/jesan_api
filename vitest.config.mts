import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Database tests share one database, so test files run one after another.
    fileParallelism: false,
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
  },
  // SWC emits decorator metadata, which NestJS dependency injection needs.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
