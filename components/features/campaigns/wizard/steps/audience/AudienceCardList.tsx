'use client'

import React, { useState } from 'react'
import { List } from 'lucide-react'
import { CheckCircleFilled } from '@/components/ui/icons/CheckCircleFilled'
import { getPricingBreakdown } from '@/lib/whatsapp-pricing'
import type { Template } from '@/types'

interface AudienceCardListProps {
  isSelected: boolean
  subtitle: string
  recipientCount: number
  onSelect: () => void
  selectedTemplate?: Template
  exchangeRate?: number | null
}

export function AudienceCardList({
  isSelected,
  subtitle,
  recipientCount,
  onSelect,
  selectedTemplate,
  exchangeRate,
}: AudienceCardListProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`relative p-6 rounded-2xl border transition-all duration-200 flex flex-col items-center justify-center gap-4 h-full min-h-47.5 ${
        isSelected
          ? 'bg-primary-600 text-white dark:bg-white dark:text-black border-primary-500 dark:border-white shadow-[0_0_20px_rgba(var(--primary-rgb),0.10)] dark:shadow-[0_0_20px_rgba(255,255,255,0.10)] ring-2 ring-primary-500/70 dark:ring-white/70'
          : 'bg-[var(--ds-bg-elevated)] border-[var(--ds-border-default)] hover:bg-[var(--ds-bg-surface)] hover:border-[var(--ds-border-strong)] text-[var(--ds-text-secondary)]'
      }`}
    >
      {isSelected && (
        <div className="absolute top-3 right-3 text-white dark:text-black">
          <CheckCircleFilled size={20} />
        </div>
      )}

      <div
        className={`p-4 rounded-full ${
          isSelected
            ? 'bg-white/20 text-white dark:bg-gray-200 dark:text-black'
            : 'bg-[var(--ds-bg-surface)] text-[var(--ds-text-secondary)]'
        }`}
      >
        <List size={24} />
      </div>

      <div className="text-center">
        <h3 className="font-bold text-sm">Lista</h3>
        <p
          className={`text-xs mt-1 ${
            isSelected ? 'text-white/70 dark:text-gray-600' : 'text-[var(--ds-text-muted)]'
          }`}
        >
          {subtitle}
        </p>
        {isSelected && selectedTemplate ? (
          <p className="text-xs mt-2 font-bold text-primary-600">
            {
              getPricingBreakdown(
                selectedTemplate.category,
                recipientCount,
                0,
                exchangeRate ?? 5.0
              ).totalBRLFormatted
            }
          </p>
        ) : null}
      </div>
    </button>
  )
}

interface ListsSheetProps {
  lists: Array<{ id: string; name: string; memberCount?: number }>
  selectedListId: string | null
  isLoading?: boolean
  onClose: () => void
  onSelect: (listId: string) => void | Promise<void>
}

export function ListsSheet({
  lists,
  selectedListId,
  isLoading,
  onClose,
  onSelect,
}: ListsSheetProps) {
  const [busyId, setBusyId] = useState<string | null>(null)

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl bg-zinc-950 border border-white/10 shadow-xl overflow-hidden">
        <div className="p-5 border-b border-white/10 flex items-center justify-between">
          <div>
            <h3 className="text-white font-semibold">Escolher lista</h3>
            <p className="text-xs text-gray-400 mt-1">Dispara apenas para os membros da lista.</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-sm">
            Fechar
          </button>
        </div>
        <div className="max-h-80 overflow-y-auto p-3 space-y-2">
          {isLoading && <p className="text-sm text-gray-400 p-3">Carregando listas...</p>}
          {!isLoading && lists.length === 0 && (
            <p className="text-sm text-gray-400 p-3">
              Nenhuma lista ainda. Crie em Contatos → Listas.
            </p>
          )}
          {lists.map((list) => (
            <button
              key={list.id}
              type="button"
              disabled={busyId !== null}
              onClick={async () => {
                setBusyId(list.id)
                try {
                  await onSelect(list.id)
                  onClose()
                } finally {
                  setBusyId(null)
                }
              }}
              className={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                selectedListId === list.id
                  ? 'border-primary-500 bg-primary-500/10 text-white'
                  : 'border-white/10 bg-zinc-900/60 text-gray-200 hover:border-white/20'
              }`}
            >
              <div className="font-medium text-sm">{list.name}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                {list.memberCount ?? 0} contato(s)
                {busyId === list.id ? ' • carregando...' : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
