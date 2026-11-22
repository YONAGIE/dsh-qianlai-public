// 把头像和会话界面模块内联到 DSH 浏览器模块 lib/client.js。
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { taxFields } from '../lib/onboarding-fields.js'
import { taxRegionCities, taxScanCities } from '../lib/tax-portals.js'

const root = new URL('..', import.meta.url)
const source = readFileSync(new URL('client/client.src.js', root), 'utf8')
const onboardingDate = readFileSync(new URL('client/onboarding-date.src.js', root), 'utf8').replace(/^export /gm, '')
const onboardingChat = readFileSync(new URL('client/onboarding-chat.src.js', root), 'utf8').replace(/^export /gm, '')
const reportChat = readFileSync(new URL('client/report-chat.src.js', root), 'utf8').replace(/^export /gm, '')
const avatar = readFileSync(new URL('assets/zhangjie/avatar.png', root)).toString('base64')
mkdirSync(new URL('lib/', root), { recursive: true })
writeFileSync(new URL('lib/client.js', root), source
  .replace('__AVATAR_DATA_URL__', `data:image/png;base64,${avatar}`)
  .replace('/* onboarding-date-client */', () => onboardingDate)
  .replace('/* onboarding-chat-client */', () => onboardingChat)
  .replace('/* report-chat-client */', () => reportChat)
  .replace('/* tax-region-catalogue */ {}', JSON.stringify(taxRegionCities))
  .replace('/* tax-fields */ []', JSON.stringify(taxFields))
  .replace('/* tax-scan-cities */ {}', JSON.stringify(taxScanCities())))

// Ship SheetJS CE's official full build and license without rewriting either.
// A URL dependency is valid for source development but rejected as an archive
// subdependency by pnpm 12's default supply-chain policy.
const xlsxRoot = dirname(realpathSync.native(createRequire(import.meta.url).resolve('xlsx')))
mkdirSync(new URL('lib/vendor/', root), { recursive: true })
copyFileSync(join(xlsxRoot, 'dist/xlsx.full.min.js'), new URL('lib/vendor/xlsx.cjs', root))
copyFileSync(join(xlsxRoot, 'LICENSE'), new URL('lib/vendor/xlsx.LICENSE', root))
