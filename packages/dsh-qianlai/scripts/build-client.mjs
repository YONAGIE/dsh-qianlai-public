// 把 client/client.src.js 里的头像占位换成内联图片，写到 lib/client.js。
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const root = new URL('..', import.meta.url)
const source = readFileSync(new URL('client/client.src.js', root), 'utf8')
const avatar = readFileSync(new URL('assets/zhangjie/avatar.png', root)).toString('base64')
mkdirSync(new URL('lib/', root), { recursive: true })
writeFileSync(new URL('lib/client.js', root), source.replace('__AVATAR_DATA_URL__', `data:image/png;base64,${avatar}`))

// Ship SheetJS CE's official full build and license without rewriting either.
// A URL dependency is valid for source development but rejected as an archive
// subdependency by pnpm 12's default supply-chain policy.
const xlsxRoot = dirname(realpathSync.native(createRequire(import.meta.url).resolve('xlsx')))
mkdirSync(new URL('lib/vendor/', root), { recursive: true })
copyFileSync(join(xlsxRoot, 'dist/xlsx.full.min.js'), new URL('lib/vendor/xlsx.cjs', root))
copyFileSync(join(xlsxRoot, 'LICENSE'), new URL('lib/vendor/xlsx.LICENSE', root))
