import { describe, it, expect } from 'vitest'
import { TAG_CHIP_LIMIT, buildVisibleTagChips } from './campaign-wizard'

describe('buildVisibleTagChips', () => {
  const tags = Array.from({ length: 20 }, (_, i) => `tag-${String(i).padStart(2, '0')}`)

  it('mostra as primeiras N tags quando nada está selecionado', () => {
    expect(buildVisibleTagChips(tags, [])).toEqual(tags.slice(0, TAG_CHIP_LIMIT))
  })

  it('inclui tags selecionadas que ficariam escondidas, preservando a ordem', () => {
    const visible = buildVisibleTagChips(tags, ['tag-19', 'tag-10'])
    expect(visible).toEqual([...tags.slice(0, TAG_CHIP_LIMIT), 'tag-10', 'tag-19'])
  })

  it('não duplica tag selecionada que já está entre as primeiras', () => {
    const visible = buildVisibleTagChips(tags, ['tag-00'])
    expect(visible).toEqual(tags.slice(0, TAG_CHIP_LIMIT))
  })

  it('devolve todas quando há menos tags que o limite', () => {
    expect(buildVisibleTagChips(['a', 'b'], [])).toEqual(['a', 'b'])
  })

  it('respeita limite customizado', () => {
    expect(buildVisibleTagChips(tags, [], 3)).toEqual(['tag-00', 'tag-01', 'tag-02'])
  })
})
