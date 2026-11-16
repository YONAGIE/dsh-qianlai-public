import { join } from 'node:path'

import { loadPack } from '../lib/pack.js'
import { seedSampleBook } from '../lib/sample-book.js'
import { BookStore } from '../lib/store.js'

/** Historical scenarios deliberately start with synthetic data in a fresh test home. */
export function seedSyntheticBook(home) {
  const store = new BookStore(join(home, 'moneycome', 'book.sqlite'))
  try {
    if (!seedSampleBook(store, loadPack(), new Date())) throw Error('Expected a fresh synthetic book.')
  } finally {
    store.close()
  }
}
