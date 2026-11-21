export type OfferMatchKind = 'exact_match' | 'bundle_or_pack' | 'variant_or_accessory'

export interface ShopOffer {
  offerId: string
  productId: string
  variantId: string
  title: string
  sellerName: string
  sellerDomain: string
  priceMinor: number
  currency: string
  formattedPrice: string
  priceUsd: number | null
  available: boolean
  url: string
  matchKind: OfferMatchKind
  matchNote: string
}

export interface ShopSearchEntry {
  mpn: string
  query: string
  status: 'ok' | 'no_results' | 'error'
  offers: ShopOffer[]
  warnings: string[]
  error?: string
  retrievedAt: string
}

export type ShopSearchResponse = ShopSearchEntry
