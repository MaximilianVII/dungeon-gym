import { DEFAULT_GENES, type Genes } from '../src/bot/genome'

/** Default genes with overrides (fresh copy). */
export function genes(over: Partial<Genes> = {}): Genes {
  return { ...DEFAULT_GENES, levelUpOrder: [], ...over }
}
