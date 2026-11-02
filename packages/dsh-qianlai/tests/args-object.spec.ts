import { describe, expect, it } from 'vitest'

import { checkArgs } from '../src/args.js'

describe('JSON 字典字段的自身属性语义', () => {
  const dictionary = { type: 'object', additionalProperties: { type: 'string' } }
  it('与 JavaScript 内置属性同名的字典值也必须校验类型', () => {
    expect(checkArgs(dictionary, { constructor: true }).problems).toEqual([expect.stringContaining('constructor')])
  })
  it('同名字典字段保持正常数字转字符串兼容', () => {
    expect(checkArgs(dictionary, { toString: 42, hasOwnProperty: 3 }).args).toEqual({ toString: '42', hasOwnProperty: '3' })
  })
  it('特殊 JSON 键作为普通数据保留，不改变返回对象原型', () => {
    const input = Object.fromEntries([['__proto__', '合成值']])
    const result = checkArgs(dictionary, input)
    expect(result.problems).toEqual([])
    expect(Object.getPrototypeOf(result.args)).toBe(Object.prototype)
    expect(Object.hasOwn(result.args, '__proto__')).toBe(true)
    expect(JSON.stringify(result.args)).toBe(JSON.stringify(input))
  })
  it('required 必须由实际提交的自身字段满足', () => {
    expect(checkArgs({ type: 'object', properties: { constructor: { type: 'string' } }, required: ['constructor'] }, {}).problems)
      .toEqual(['缺少 constructor'])
  })
})
