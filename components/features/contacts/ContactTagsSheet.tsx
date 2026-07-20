'use client'

import React, { useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Tags, Plus, Pencil, Trash2, Check, X } from 'lucide-react'

interface ContactTagsSheetProps {
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  tags: string[]
  isLoading?: boolean
  onCreate: (tag: string) => Promise<void> | void
  onRename: (from: string, to: string) => Promise<void> | void
  onDelete: (tag: string) => Promise<void> | void
}

export function ContactTagsSheet({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  tags,
  isLoading,
  onCreate,
  onRename,
  onDelete,
}: ContactTagsSheetProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = isControlled ? controlledOnOpenChange! : setInternalOpen

  const [newTag, setNewTag] = useState('')
  const [editingTag, setEditingTag] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingTags, setPendingTags] = useState<string[]>([])

  const allTags = Array.from(new Set([...tags, ...pendingTags])).sort((a, b) =>
    a.localeCompare(b, 'pt-BR')
  )

  const handleCreate = async () => {
    const tag = newTag.trim()
    if (!tag || busy) return
    setBusy(true)
    try {
      await onCreate(tag)
      setPendingTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]))
      setNewTag('')
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async () => {
    if (!editingTag || !editValue.trim() || busy) return
    setBusy(true)
    try {
      await onRename(editingTag, editValue.trim())
      setPendingTags((prev) =>
        prev.map((t) => (t === editingTag ? editValue.trim() : t)).filter((t) => t !== editingTag)
      )
      setEditingTag(null)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (tag: string) => {
    if (busy) return
    if (!window.confirm(`Remover a tag "${tag}" de todos os contatos?`)) return
    setBusy(true)
    try {
      await onDelete(tag)
      setPendingTags((prev) => prev.filter((t) => t !== tag))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {children && <SheetTrigger asChild>{children}</SheetTrigger>}
      <SheetContent className="sm:max-w-md w-full overflow-y-auto bg-zinc-950 border-l border-white/10 p-0 flex flex-col sm:w-135">
        <SheetHeader className="p-6 border-b border-white/10">
          <SheetTitle className="text-white flex items-center gap-2">
            <div className="p-2 bg-primary-500/10 rounded-lg text-primary-500">
              <Tags size={18} />
            </div>
            Gerenciar tags
          </SheetTitle>
          <SheetDescription className="text-gray-400">
            Crie, renomeie ou remova tags usadas na audiência e nos disparos.
          </SheetDescription>
        </SheetHeader>

        <div className="p-6 space-y-6 flex-1 overflow-y-auto">
          <div className="space-y-3 rounded-xl border border-white/10 p-4 bg-white/5">
            <p className="text-sm font-medium text-white">Nova tag</p>
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="Ex.: black-friday"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-white/10 text-sm text-white"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <Button variant="brand" size="sm" onClick={handleCreate} disabled={busy || !newTag.trim()}>
              <Plus size={16} />
              Criar tag
            </Button>
            <p className="text-xs text-gray-500">
              Tags novas entram no filtro após você aplicá-las a contatos (ou via seleção em massa).
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              {isLoading ? 'Carregando...' : `${allTags.length} tag(s)`}
            </p>
            {allTags.length === 0 && !isLoading && (
              <p className="text-sm text-gray-400">Nenhuma tag ainda.</p>
            )}
            {allTags.map((tag) => (
              <div
                key={tag}
                className="flex items-center gap-2 rounded-xl border border-white/10 p-3 bg-zinc-900/60"
              >
                {editingTag === tag ? (
                  <div className="flex-1 flex items-center gap-2">
                    <input
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="flex-1 px-2 py-1.5 rounded-lg bg-zinc-950 border border-white/10 text-sm text-white"
                      onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                    />
                    <button type="button" className="p-2 text-primary-400" onClick={handleRename}>
                      <Check size={14} />
                    </button>
                    <button type="button" className="p-2 text-gray-400" onClick={() => setEditingTag(null)}>
                      <X size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <span className="flex-1 text-sm text-white truncate">{tag}</span>
                    <button
                      type="button"
                      className="p-2 text-gray-400 hover:text-white"
                      onClick={() => {
                        setEditingTag(tag)
                        setEditValue(tag)
                      }}
                      aria-label="Renomear tag"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="p-2 text-gray-400 hover:text-red-400"
                      onClick={() => handleDelete(tag)}
                      aria-label="Excluir tag"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
