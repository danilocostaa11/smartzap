'use client'

/**
 * useContactLists — CRUD de listas estáticas de contatos (audiência salva).
 *
 * As listas são independentes das tags e da supressão: servem para montar
 * uma audiência reutilizável em campanhas.
 */

import { useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { ContactList } from '@/types'

const listsKey = ['contact-lists'] as const

async function fetchLists(): Promise<ContactList[]> {
  const res = await fetch('/api/contacts/lists', { cache: 'no-store' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Falha ao buscar listas')
  }
  const data = await res.json()
  return data.lists ?? []
}

async function createList(dto: { name: string; color?: string; description?: string | null }): Promise<ContactList> {
  const res = await fetch('/api/contacts/lists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Falha ao criar lista')
  }
  return res.json()
}

async function updateList(id: string, dto: { name?: string; color?: string; description?: string | null }): Promise<ContactList> {
  const res = await fetch(`/api/contacts/lists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dto),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Falha ao atualizar lista')
  }
  return res.json()
}

async function deleteList(id: string): Promise<void> {
  const res = await fetch(`/api/contacts/lists/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Falha ao excluir lista')
  }
}

export function useContactListsController() {
  const queryClient = useQueryClient()

  const { data: lists = [], isLoading } = useQuery({
    queryKey: listsKey,
    queryFn: fetchLists,
    staleTime: 30_000,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: listsKey })

  const createMutation = useMutation({ mutationFn: createList, onSuccess: invalidate })
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; color?: string } }) => updateList(id, data),
    onSuccess: invalidate,
  })
  const deleteMutation = useMutation({ mutationFn: deleteList, onSuccess: invalidate })

  const onCreate = useCallback(
    async (data: { name: string; color?: string }) => {
      await createMutation.mutateAsync(data)
    },
    [createMutation]
  )

  const onUpdate = useCallback(
    async (id: string, data: { name: string; color?: string }) => {
      await updateMutation.mutateAsync({ id, data })
    },
    [updateMutation]
  )

  const onDelete = useCallback(
    async (id: string) => {
      await deleteMutation.mutateAsync(id)
    },
    [deleteMutation]
  )

  return { lists, isLoading, onCreate, onUpdate, onDelete }
}
