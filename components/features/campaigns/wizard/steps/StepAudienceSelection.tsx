'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  TestContactCard,
  AudienceCardAll,
  AudienceCardSegments,
  AudienceCardList,
  ListsSheet,
  SegmentsSheet,
  RefineSheet,
  ContactSelectionList,
  LegacyAudienceMode,
  useAudienceSelection,
} from './audience';
import { LimitWarning } from '@/components/ui/LimitWarning';
import { contactService } from '@/services/contactService';
import { toast } from 'sonner';

// Re-export types for backward compatibility
export type {
  AudienceCriteria,
  AudiencePreset,
  AudienceStats,
  StepAudienceSelectionProps,
} from './audience';

import type { StepAudienceSelectionProps } from './audience';

export function StepAudienceSelection(props: StepAudienceSelectionProps) {
  const {
    recipientSource,
    setRecipientSource,
    totalContacts,
    recipientCount,
    allContacts,
    filteredContacts,
    selectedContacts,
    selectedContactIds,
    contactSearchTerm,
    setContactSearchTerm,
    toggleContact,
    testContact,
    selectedTemplate,
    exchangeRate,
    isJobsAudienceMode,
    audiencePreset,
    audienceCriteria,
    audienceStats,
    selectAudiencePreset,
    applyAudienceCriteria,
    selectContactList,
    selectedListId,
    onSelectedListIdChange,
    currentLimit,
    isOverLimit,
    isAudienceRefineOpen,
    setIsAudienceRefineOpen,
    isSegmentsSheetOpen,
    setIsSegmentsSheetOpen,
    segmentTagDraft,
    setSegmentTagDraft,
    segmentDdiDraft,
    setSegmentDdiDraft,
    segmentCustomFieldKeyDraft,
    setSegmentCustomFieldKeyDraft,
    segmentCustomFieldModeDraft,
    setSegmentCustomFieldModeDraft,
    segmentCustomFieldValueDraft,
    setSegmentCustomFieldValueDraft,
    segmentOneContactDraft,
    setSegmentOneContactDraft,
    audienceDraft,
    setAudienceDraft,
    customFields,
    liveValidation,
    setShowUpgradeModal,
  } = props;

  const [isListsSheetOpen, setIsListsSheetOpen] = useState(false);
  const [localSelectedListId, setLocalSelectedListId] = useState<string | null>(selectedListId ?? null);

  const listsQuery = useQuery({
    queryKey: ['contactLists'],
    queryFn: contactService.getLists,
    staleTime: 30_000,
  });

  // Derived state from hook
  const {
    eligibleContactsCount,
    segmentsSubtitle,
    isAutoSpecificSelection,
    isAllCardSelected,
    isSegmentsCardSelected,
  } = useAudienceSelection({
    allContacts,
    audienceStats,
    audiencePreset,
    audienceCriteria,
    customFields,
    recipientSource,
    isJobsAudienceMode,
  });

  const activeListId = selectedListId ?? localSelectedListId;
  const selectedList = (listsQuery.data || []).find((l) => l.id === activeListId);
  const isListCardSelected =
    !!activeListId && recipientSource === 'specific' && selectedContactIds.length > 0 && !!selectedList;

  // Helper: pick one contact from segments sheet
  const pickOneContact = (contactId: string, prefillSearch?: string) => {
    if (recipientSource === 'test') return;
    onSelectedListIdChange?.(null);
    setLocalSelectedListId(null);
    selectAudiencePreset?.('manual');
    if (prefillSearch !== undefined) setContactSearchTerm(prefillSearch);
    setTimeout(() => {
      toggleContact(contactId);
    }, 0);
  };

  // Check if test contact is selected
  const isTestSelected = audiencePreset === 'test' || recipientSource === 'test';

  return (
    <div className="flex-1 min-h-0 flex flex-col space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-auto p-6 pb-8">
      {/* Header */}
      <div className="text-center mb-4 shrink-0">
        <h2 className="text-2xl font-bold text-[var(--ds-text-primary)] mb-2">Escolha seu Público</h2>
        <p className="text-[var(--ds-text-secondary)]">Quem deve receber esta campanha?</p>
      </div>

      {isJobsAudienceMode ? (
        <>
          {/* Test Contact Card */}
          {testContact && (
            <TestContactCard
              testContact={testContact}
              isSelected={isTestSelected}
              onSelect={() => {
                onSelectedListIdChange?.(null);
                setLocalSelectedListId(null);
                selectAudiencePreset?.('test');
              }}
              selectedTemplate={selectedTemplate}
              exchangeRate={exchangeRate}
            />
          )}

          {/* Main Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <AudienceCardAll
              eligibleContactsCount={eligibleContactsCount}
              currentLimit={currentLimit}
              isSelected={isAllCardSelected && !isListCardSelected}
              onSelect={() => {
                onSelectedListIdChange?.(null);
                setLocalSelectedListId(null);
                selectAudiencePreset?.('all');
              }}
              selectedTemplate={selectedTemplate}
              exchangeRate={exchangeRate}
            />

            <AudienceCardSegments
              isSelected={isSegmentsCardSelected && !isListCardSelected}
              subtitle={segmentsSubtitle}
              recipientCount={recipientCount}
              onSelect={() => {
                onSelectedListIdChange?.(null);
                setLocalSelectedListId(null);
                setIsSegmentsSheetOpen(true);
                setIsAudienceRefineOpen(false);
              }}
              selectedTemplate={selectedTemplate}
              exchangeRate={exchangeRate}
            />

            <AudienceCardList
              isSelected={isListCardSelected}
              subtitle={
                selectedList
                  ? `${selectedList.name} • ${selectedContactIds.length} contatos`
                  : `${listsQuery.data?.length ?? 0} listas disponíveis`
              }
              recipientCount={isListCardSelected ? recipientCount : 0}
              onSelect={() => {
                setIsListsSheetOpen(true);
                setIsSegmentsSheetOpen(false);
                setIsAudienceRefineOpen(false);
              }}
              selectedTemplate={selectedTemplate}
              exchangeRate={exchangeRate}
            />
          </div>

          {isListsSheetOpen && (
            <ListsSheet
              lists={listsQuery.data || []}
              selectedListId={activeListId}
              isLoading={listsQuery.isLoading}
              onClose={() => setIsListsSheetOpen(false)}
              onSelect={async (listId) => {
                if (!selectContactList) {
                  toast.error('Seleção de lista indisponível');
                  return;
                }
                try {
                  const count = await selectContactList(listId);
                  setLocalSelectedListId(listId);
                  onSelectedListIdChange?.(listId);
                  toast.success(
                    count > 0
                      ? `Lista selecionada: ${count} contato(s)`
                      : 'Lista vazia — adicione contatos em Contatos → Listas'
                  );
                } catch (error: any) {
                  toast.error(error?.message || 'Falha ao carregar lista');
                }
              }}
            />
          )}

          {/* Segments Sheet */}
          {isSegmentsSheetOpen && (
            <SegmentsSheet
              audienceStats={audienceStats}
              audienceCriteria={audienceCriteria}
              customFields={customFields}
              allContacts={allContacts}
              recipientSource={recipientSource}
              segmentTagDraft={segmentTagDraft}
              setSegmentTagDraft={setSegmentTagDraft}
              segmentDdiDraft={segmentDdiDraft}
              setSegmentDdiDraft={setSegmentDdiDraft}
              segmentCustomFieldKeyDraft={segmentCustomFieldKeyDraft}
              setSegmentCustomFieldKeyDraft={setSegmentCustomFieldKeyDraft}
              segmentCustomFieldModeDraft={segmentCustomFieldModeDraft}
              setSegmentCustomFieldModeDraft={setSegmentCustomFieldModeDraft}
              segmentCustomFieldValueDraft={segmentCustomFieldValueDraft}
              setSegmentCustomFieldValueDraft={setSegmentCustomFieldValueDraft}
              segmentOneContactDraft={segmentOneContactDraft}
              setSegmentOneContactDraft={setSegmentOneContactDraft}
              applyAudienceCriteria={applyAudienceCriteria}
              onClose={() => setIsSegmentsSheetOpen(false)}
              onOpenRefine={() => {
                setIsSegmentsSheetOpen(false);
                setIsAudienceRefineOpen(true);
              }}
              onPickOneContact={pickOneContact}
            />
          )}

          {/* Manual Selection Button */}
          <div className="mt-4 flex items-center justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-[var(--ds-border-default)] bg-[var(--ds-bg-elevated)] hover:bg-[var(--ds-bg-surface)] text-[var(--ds-text-primary)]"
              onClick={() => selectAudiencePreset?.('manual')}
              disabled={recipientSource === 'test'}
            >
              Selecionar manualmente
            </Button>
          </div>

          {/* Refine Sheet */}
          {isAudienceRefineOpen && (
            <RefineSheet
              audienceDraft={audienceDraft}
              setAudienceDraft={setAudienceDraft}
              audienceCriteria={audienceCriteria}
              applyAudienceCriteria={applyAudienceCriteria}
              recipientSource={recipientSource}
              onClose={() => setIsAudienceRefineOpen(false)}
              onOpenSegments={() => {
                setIsAudienceRefineOpen(false);
                setIsSegmentsSheetOpen(true);
              }}
            />
          )}
        </>
      ) : (
        <>
          {/* Legacy Mode: Test Contact Card */}
          {testContact && (
            <TestContactCard
              testContact={testContact}
              isSelected={recipientSource === 'test'}
              onSelect={() => setRecipientSource('test')}
              selectedTemplate={selectedTemplate}
              exchangeRate={exchangeRate}
            />
          )}

          {/* Legacy Mode: All/Specific Cards */}
          <LegacyAudienceMode
            recipientSource={recipientSource}
            setRecipientSource={setRecipientSource}
            totalContacts={totalContacts}
            recipientCount={recipientCount}
            currentLimit={currentLimit}
            selectedTemplate={selectedTemplate}
            exchangeRate={exchangeRate}
          />
        </>
      )}

      {/* Contact Selection List */}
      {recipientSource === 'specific' && (
        <ContactSelectionList
          contacts={isAutoSpecificSelection ? selectedContacts : filteredContacts}
          selectedContactIds={selectedContactIds}
          toggleContact={toggleContact}
          contactSearchTerm={contactSearchTerm}
          setContactSearchTerm={setContactSearchTerm}
          totalContacts={totalContacts}
          recipientCount={recipientCount}
          isAutoSelection={isAutoSpecificSelection}
          onSwitchToManual={
            isAutoSpecificSelection
              ? () => selectAudiencePreset?.('manual')
              : undefined
          }
        />
      )}

      {/* Limit Warning */}
      {recipientCount > 0 && isOverLimit && liveValidation && (
        <LimitWarning
          recipientCount={recipientCount}
          currentLimit={currentLimit}
          onShowUpgradeModal={() => setShowUpgradeModal(true)}
        />
      )}
    </div>
  );
}
