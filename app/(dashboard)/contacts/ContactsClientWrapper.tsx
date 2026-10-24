'use client'

import { List } from 'lucide-react'
import { useContactsController } from '@/hooks/useContacts'
import { useContactListsController } from '@/hooks/useContactLists'
import { ContactListView } from '@/components/features/contacts/ContactListView'
import { ContactListsSheet } from '@/components/features/contacts/ContactListsSheet'
import type { ContactsInitialData } from './actions'

interface ContactsClientWrapperProps {
  initialData?: ContactsInitialData
}

export function ContactsClientWrapper({ initialData }: ContactsClientWrapperProps) {
  const controller = useContactsController(initialData)
  const lists = useContactListsController()

  // Não mostra loading se já temos initialData do servidor
  const showLoading = controller.isLoading && !initialData

  return (
    <>
    <div className="mb-3 flex justify-end">
      <ContactListsSheet
        lists={lists.lists}
        isLoading={lists.isLoading}
        onCreate={lists.onCreate}
        onUpdate={lists.onUpdate}
        onDelete={lists.onDelete}
      >
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg border border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] px-3 py-2 text-sm text-[var(--ds-text-secondary)] transition hover:bg-[var(--ds-bg-hover)]"
        >
          <List className="size-4" />
          Listas
        </button>
      </ContactListsSheet>
    </div>
    <ContactListView
      contacts={controller.contacts}
      stats={controller.stats}
      tags={controller.tags}
      customFields={controller.customFields}
      onRefreshCustomFields={controller.refreshCustomFields}
      isLoading={showLoading}
      searchTerm={controller.searchTerm}
      onSearchChange={controller.setSearchTerm}
      statusFilter={controller.statusFilter}
      onStatusFilterChange={controller.setStatusFilter}
      tagFilter={controller.tagFilter}
      onTagFilterChange={controller.setTagFilter}
      currentPage={controller.currentPage}
      totalPages={controller.totalPages}
      totalFiltered={controller.totalFiltered}
      onPageChange={controller.setCurrentPage}
      selectedIds={controller.selectedIds}
      onToggleSelect={controller.toggleSelect}
      onToggleSelectAll={controller.toggleSelectAll}
      selectAllGlobal={controller.selectAllGlobal}
      clearSelection={controller.clearSelection}
      isAllSelected={controller.isAllSelected}
      isSomeSelected={controller.isSomeSelected}
      isAddModalOpen={controller.isAddModalOpen}
      setIsAddModalOpen={controller.setIsAddModalOpen}
      isImportModalOpen={controller.isImportModalOpen}
      setIsImportModalOpen={controller.setIsImportModalOpen}
      isEditModalOpen={controller.isEditModalOpen}
      setIsEditModalOpen={controller.setIsEditModalOpen}
      isDeleteModalOpen={controller.isDeleteModalOpen}
      editingContact={controller.editingContact}
      deleteTarget={controller.deleteTarget}
      onAddContact={controller.onAddContact}
      onEditContact={controller.onEditContact}
      onUpdateContact={controller.onUpdateContact}
      onDeleteClick={controller.onDeleteClick}
      onBulkDeleteClick={controller.onBulkDeleteClick}
      onConfirmDelete={controller.onConfirmDelete}
      onCancelDelete={controller.onCancelDelete}
      onImport={controller.onImport}
      isImporting={controller.isImporting}
      isDeleting={controller.isDeleting}
      onUnsuppress={controller.onUnsuppress}
    />
    </>
  )
}
