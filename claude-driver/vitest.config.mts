// 使用方法：npm test / npm run test:watch
// 编译说明：vitest 配置，仅用于测试环境
// 代码说明：Vitest 测试框架配置——jsdom 环境 + @shared/@renderer alias

import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    exclude: ['node_modules', 'dist', 'out'],
    setupFiles: ['src/__tests__/helpers/setup.ts'],
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
    },
  },
})
