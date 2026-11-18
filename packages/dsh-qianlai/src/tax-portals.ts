import regions from './tax-regions.json' with { type: 'json' }

export const taxRegionCities: Readonly<Record<string, readonly string[]>> = regions

export interface TaxPortal {
  readonly name: string
  readonly homeOrigin: string
  readonly portalOrigins: readonly string[]
  readonly loginOrigin: string
  readonly acceptsAuthority: (name: string) => boolean
  readonly excludedCities?: readonly string[]
}

const portals: Readonly<Record<string, TaxPortal>> = {
  北京市: {
    name: '北京',
    homeOrigin: 'https://etax.beijing.chinatax.gov.cn:8443',
    portalOrigins: ['https://etax.beijing.chinatax.gov.cn:8443', 'https://etax.beijing.chinatax.gov.cn'],
    loginOrigin: 'https://tpass.beijing.chinatax.gov.cn:8443',
    acceptsAuthority: name => /(?:北京市|北京经济技术开发区)/.test(name),
  },
  浙江省: {
    name: '浙江',
    homeOrigin: 'https://etax.zhejiang.chinatax.gov.cn:8443',
    portalOrigins: ['https://etax.zhejiang.chinatax.gov.cn:8443', 'https://etax.zhejiang.chinatax.gov.cn'],
    loginOrigin: 'https://tpass.zhejiang.chinatax.gov.cn:8443',
    acceptsAuthority: name => /(?:浙江省|杭州|温州|嘉兴|湖州|绍兴|金华|衢州|舟山|台州|丽水)/.test(name) && !/宁波/.test(name),
    excludedCities: ['宁波市'],
  },
}

export function isTaxRegion(province: string, city: string): boolean {
  return Object.hasOwn(taxRegionCities, province) && (taxRegionCities[province]?.includes(city) ?? false)
}

export function taxPortalFor(province: string, city: string): TaxPortal | undefined {
  if (!isTaxRegion(province, city) || !Object.hasOwn(portals, province)) return undefined
  const portal = portals[province]
  return portal?.excludedCities?.includes(city) ? undefined : portal
}

export function taxScanCities(): Record<string, string[]> {
  const supported: Record<string, string[]> = {}
  for (const [province, cities] of Object.entries(taxRegionCities)) {
    const connected = cities.filter(city => taxPortalFor(province, city))
    if (connected.length) supported[province] = connected
  }
  return supported
}
