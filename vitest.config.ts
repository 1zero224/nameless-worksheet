import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

// 让工作区包从源码加载，无需先构建
export default defineConfig({
  resolve: {
    alias: {
      '@nw/shared': path.resolve(root, 'packages/shared/src/index.ts'),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'shared', include: ['packages/shared/src/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: ['apps/server/test/**/*.test.ts'],
          globalSetup: ['apps/server/test/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: { name: 'web', include: ['apps/web/src/**/*.test.ts'] },
      },
    ],
  },
});
