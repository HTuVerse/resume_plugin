import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/unit/**/*.test.ts'],
    // 评测要求两次运行结果一致：禁用随机顺序
    sequence: { shuffle: false }
  }
})
