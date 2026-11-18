import { describe, expect, it } from 'vitest'

import { imageMediaType } from '../src/wechat/ilink.js'
import { splitForWechat, toWechatText } from '../src/wechat/index.js'

describe('微信纯文本', () => {
  it('将标题与正文分段，把表格行转换成带字段名的记录', () => {
    const markdown = [
      '## 1月利润',
      '**利润：18,690.00 元**',
      '',
      '| 日期 | 金额 |',
      '|---|---|',
      '| 01-05 | 100,000.00 |',
      '用 `moneycome` 记的',
    ].join('\n')
    expect(toWechatText(markdown)).toBe('1月利润\n\n利润：18,690.00 元\n\n• 日期 01-05 · 金额 100,000.00\n\n用 moneycome 记的')
  })

  it('识别缺少外侧竖线的凭证明细，保留负数、前导零及转义竖线', () => {
    const markdown = [
      '已记两张凭证。',
      '凭证 | 日期 | 内容 | 金额',
      ':--- | :---: | --- | ---:',
      'PZ-SYNTH-001 | 11-03 | 设计 A \\| B | **3,030.00**',
      '| PZ-SYNTH-002 | 11-06 | 银行手续费 | -30.00 |',
      '- 下一步：补流水 | 核对余额',
    ].join('\r\n')
    expect(toWechatText(markdown)).toBe([
      '已记两张凭证。',
      '• 凭证 PZ-SYNTH-001 · 日期 11-03 · 内容 设计 A | B · 金额 3,030.00',
      '• 凭证 PZ-SYNTH-002 · 日期 11-06 · 内容 银行手续费 · 金额 -30.00',
      '- 下一步：补流水 | 核对余额',
    ].join('\n\n'))
  })

  it('保留普通含竖线的文本、分隔线和代码中的表格示例', () => {
    const markdown = [
      '核对范围 | 其他事项',
      '---',
      '~~~md',
      '| 名称 | 值 |',
      '| --- | --- |',
      '| `合成` | **100** |',
      '~~~',
    ].join('\n')
    expect(toWechatText(markdown)).toBe(markdown)
  })

  it('长表格在记录之间拆分，每个气泡保留列名', () => {
    const markdown = [
      '日期 | 金额',
      '---|---',
      '11-03 | 100.00',
      '11-13 | -50.00',
    ].join('\n')
    expect(splitForWechat(toWechatText(markdown), 30)).toEqual([
      '• 日期 11-03 · 金额 100.00',
      '• 日期 11-13 · 金额 -50.00',
    ])
  })

  it('超长按段落拆，每段不超上限', () => {
    const text = ['甲'.repeat(10), '乙'.repeat(10), '丙'.repeat(25)].join('\n\n')
    const chunks = splitForWechat(text, 22)
    expect(chunks[0]).toBe(`${'甲'.repeat(10)}\n\n${'乙'.repeat(10)}`)
    expect(chunks.every((c) => c.length <= 22)).toBe(true)
    expect(chunks.join('')).toContain('丙'.repeat(22))
  })

  it('超长段内优先在换行处断开，必要时保留成对的代理字符', () => {
    expect(splitForWechat('甲乙\n丙丁戊己', 4)).toEqual(['甲乙\n', '丙丁戊己'])
    expect(splitForWechat('甲乙💡丙丁', 3)).toEqual(['甲乙', '💡丙', '丁'])
  })

  it('按文件头认图片格式', () => {
    expect(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(imageMediaType(Buffer.from('%PDF-1.7'))).toBeUndefined()
  })
})
