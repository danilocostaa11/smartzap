import { describe, expect, it } from 'vitest'
import {
  mergeTags,
  normalizeTagName,
  removeTags,
  renameTagInList,
  tagsEqualIgnoreOrder,
} from '@/lib/business/contact/tags'

describe('contact tags helpers', () => {
  it('normalizes tag names', () => {
    expect(normalizeTagName('  black-friday  ')).toBe('black-friday')
    expect(normalizeTagName('')).toBe('')
  })

  it('merges tags without duplicates', () => {
    expect(mergeTags(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(mergeTags(null, ['x'])).toEqual(['x'])
  })

  it('removes tags', () => {
    expect(removeTags(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
    expect(removeTags(['a'], ['z'])).toEqual(['a'])
  })

  it('renames a tag and keeps uniqueness', () => {
    expect(renameTagInList(['vip', 'lead'], 'vip', 'premium')).toEqual(['lead', 'premium'])
    expect(renameTagInList(['vip', 'premium'], 'vip', 'premium')).toEqual(['premium'])
  })

  it('compares tag lists ignoring order', () => {
    expect(tagsEqualIgnoreOrder(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(tagsEqualIgnoreOrder(['a'], ['a', 'b'])).toBe(false)
  })
})
