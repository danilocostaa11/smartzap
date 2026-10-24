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
import { List, Plus, Pencil, Trash2, Check, X } from 'lucide-react'
import type { ContactList } from '@/types'

interface ContactListsSheetProps {
  children?: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
  lists: ContactList[]
  isLoading?: boolean
  onCreate: (data: { name: string; color?: string }) => Promise<void> | void
  onUpdate: (id: string, data: { name: string; color?: string }) => Promise<void> | void
  onDelete: (id: string) => Promise<void> | void
  onSelectList?: (listId: string) => void
}

const COLORS = ['#6B7280', '#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899']

export function ContactListsSheet({
  children,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  lists,
  isLoading,
  onCreate,
  onUpdate,
  onDelete,
  onSelectList,
}: ContactListsSheetProps) {
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = isControlled ? controlledOnOpenChange! : setInternalOpen

  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#10B981')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editColor, setEditColor] = useState('#6B7280')
  const [busy, setBusy] = useState(false)

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name || busy) return
    setBusy(true)
    try {
      await onCreate({ name, color: newColor })
      setNewName('')
      setNewColor('#10B981')
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (list: ContactList) => {
    setEditingId(list.id)
    setEditName(list.name)
    setEditColor(list.color || '#6B7280')
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim() || busy) return
    setBusy(true)
    try {
      await onUpdate(editingId, { name: editName.trim(), color: editColor })
      setEditingId(null)
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (busy) return
    if (!window.confirm('Excluir esta lista? Os contatos não serão apagados.')) return
    setBusy(true)
    try {
      await onDelete(id)
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
              <List size={18} />
            </div>
            Listas de contatos
          </SheetTitle>
          <SheetDescription className="text-gray-400">
            Crie listas estáticas para organizar leads e usar nos disparos.
          </SheetDescription>
        </SheetHeader>

        <div className="p-6 space-y-6 flex-1 overflow-y-auto">
          <div className="space-y-3 rounded-xl border border-white/10 p-4 bg-white/5">
            <p className="text-sm font-medium text-white">Nova lista</p>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome da lista"
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-white/10 text-sm text-white"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setNewColor(c)}
                  className={`w-6 h-6 rounded-full border-2 ${newColor === c ? 'border-white' : 'border-transparent'}`}
                  style={{ backgroundColor: c }}
                  aria-label={`Cor ${c}`}
                />
              ))}
            </div>
            <Button variant="brand" size="sm" onClick={handleCreate} disabled={busy || !newName.trim()}>
              <Plus size={16} />
              Criar lista
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-gray-500">
              {isLoading ? 'Carregando...' : `${lists.length} lista(s)`}
            </p>
            {lists.length === 0 && !isLoading && (
              <p className="text-sm text-gray-400">Nenhuma lista ainda. Crie a primeira acima.</p>
            )}
            {lists.map((list) => (
              <div
                key={list.id}
                className="flex items-center gap-2 rounded-xl border border-white/10 p-3 bg-zinc-900/60"
              >
                {editingId === list.id ? (
                  <div className="flex-1 space-y-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="w-full px-2 py-1.5 rounded-lg bg-zinc-950 border border-white/10 text-sm text-white"
                    />
                    <div className="flex flex-wrap gap-2">
                      {COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setEditColor(c)}
                          className={`w-5 h-5 rounded-full border ${editColor === c ? 'border-white' : 'border-transparent'}`}
                          style={{ backgroundColor: c }}
                        />
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="brand" onClick={handleSaveEdit} disabled={busy}>
                        <Check size={14} />
                        Salvar
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditingId(null)}>
                        <X size={14} />
                        Cancelar
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="flex-1 text-left min-w-0"
                      onClick={() => {
                        onSelectList?.(list.id)
                        setOpen(false)
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: list.color }}
                        />
                        <span className="text-sm text-white font-medium truncate">{list.name}</span>
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5 pl-5">
                        {list.memberCount ?? 0} contato(s)
                      </p>
                    </button>
                    <button
                      type="button"
                      className="p-2 text-gray-400 hover:text-white"
                      onClick={() => startEdit(list)}
                      aria-label="Editar lista"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="p-2 text-gray-400 hover:text-red-400"
                      onClick={() => handleDelete(list.id)}
                      aria-label="Excluir lista"
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
