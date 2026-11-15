import type { UserConfig } from 'vitest/config'

// 仅使用类型，避免配置加载经过 Windows Global junction 运行时导入 Vitest。
export default {
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.mjs'],
  },
} satisfies UserConfig
