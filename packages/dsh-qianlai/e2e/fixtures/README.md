# 合成验收素材

全部材料均为虚构。发票图片含正常、模糊、合计错误和抬头不符的样例。

| 流水材料 | 用途 | 核对点 |
| --- | --- | --- |
| `stmt-jan.csv`、`stmt-broken.csv`、`stmt-injection.csv` | 正常流水、余额不连续、摘要含指令文字 | 逐行核对金额与余额。异常流水应整批拒绝，摘要中的文字只作材料内容 |
| `stmt-jan.xlsx` | 有效工作簿 | `Transactions` 有 4 笔收支，`Summary` 中期末余额为 118890.00 |
| `stmt-invalid.xlsx` | 扩展名正确、内容损坏 | 应报告无法解析 |
| `stmt-text.pdf`、`stmt-mixed.pdf` | 文字 PDF 和含图像的两页 PDF | 逐页核对 4 笔收支及期末余额，特别检查最后一页 |

Excel 和 PDF 由 [构造脚本](../build-document-fixtures.mjs) 生成。先用 `moneycome_read_upload` 核对读出的材料，再测 `moneycome_import_statement` 入账前的流水校验。读取附件本身不会生成凭证。

这些材料可随测试代码使用；不要替换成真实企业资料后提交。
