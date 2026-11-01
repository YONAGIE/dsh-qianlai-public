/**
 * 工具参数的入口校验。
 *
 * DSH 只对 `defineTool` 定义的工具按 schema 校验参数，插件用 `ctx.tools.register` 注册的不校验，
 * 模型传来什么就是什么。这里按工具自己声明的 JSON Schema（只用到 string / boolean / integer /
 * array / object 这几种）把参数过一遍：可选字段给 null 当没给；字符串字段给了数字就转成字符串；
 * 其余类型不对的报出具体位置，不往下走。
 */

interface Schema {
  readonly type?: string
  readonly enum?: readonly unknown[]
  readonly properties?: Readonly<Record<string, Schema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: Schema | boolean
  readonly items?: Schema
}

const at = (path: string) => path || '参数'

function normalize(schema: Schema, value: unknown, path: string, problems: string[]): unknown {
  const normalized = normalizeValue(schema, value, path, problems)
  if (schema.enum && !schema.enum.includes(normalized))
    problems.push(`${at(path)} 只能是 ${schema.enum.map(String).join(' / ')}`)
  return normalized
}

function normalizeValue(schema: Schema, value: unknown, path: string, problems: string[]): unknown {
  switch (schema.type) {
    case 'string':
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      problems.push(`${at(path)} 应为字符串`)
      return value
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${at(path)} 应为 true 或 false`)
      return value
    case 'integer':
      if (!Number.isSafeInteger(value)) problems.push(`${at(path)} 应为整数`)
      return value
    case 'array':
      if (!Array.isArray(value)) {
        problems.push(`${at(path)} 应为列表`)
        return value
      }
      return schema.items ? value.map((v, i) => normalize(schema.items!, v, `${path}[${i}]`, problems)) : value
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        problems.push(`${at(path)} 应为对象`)
        return value
      }
      const props = schema.properties ?? {}
      const required = new Set(schema.required ?? [])
      const out: Record<string, unknown> = {}
      for (const [key, v] of Object.entries(value)) {
        const child = `${path ? `${path}.` : ''}${key}`
        const declared = props[key] ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined)
        if (v === null && !required.has(key)) continue
        out[key] = declared ? normalize(declared, v, child, problems) : v
      }
      for (const key of required) if (out[key] === undefined) problems.push(`缺少 ${path ? `${path}.` : ''}${key}`)
      return out
    }
    default:
      return value
  }
}

/** 按 schema 整理参数。problems 为空才能用 args。 */
export function checkArgs(schema: object, value: unknown): { args: Record<string, unknown>; problems: string[] } {
  const problems: string[] = []
  const args = normalize(schema as Schema, value ?? {}, '', problems) as Record<string, unknown>
  return { args, problems }
}
