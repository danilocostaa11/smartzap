import { Contact, ContactStatus } from '../types';
import {
  processPhoneNumber
} from '../lib/phone-formatter';
import {
  parseContactsFile,
  parseContactsFromFile,
  generateImportReport,
  type ParseOptions
} from '../lib/csv-parser';
import { logger } from '../lib/logger';

export interface ContactStats {
  total: number;
  optIn: number;
  optOut: number;
}

export interface ImportResult {
  imported: number;
  failed: number;
  duplicates: number;
  report: string;
}

export interface ContactListParams {
  limit: number;
  offset: number;
  search?: string;
  status?: string;
  tag?: string;
  listId?: string;
}

export interface ContactListResult {
  data: Contact[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Contact Service
 * All data is stored in Main Database (source of truth)
 */
export const contactService = {
  getAll: async (): Promise<Contact[]> => {
    const response = await fetch('/api/contacts', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Falha ao buscar contatos');
    }
    return response.json();
  },

  getById: async (id: string): Promise<Contact | undefined> => {
    const response = await fetch(`/api/contacts/${id}`, { cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 404) return undefined;
      return undefined;
    }
    return response.json();
  },

  getStats: async (): Promise<ContactStats> => {
    const response = await fetch('/api/contacts/stats', { cache: 'no-store' });
    if (!response.ok) {
      return { total: 0, optIn: 0, optOut: 0 };
    }
    return response.json();
  },

  getTags: async (): Promise<string[]> => {
    const response = await fetch('/api/contacts/tags', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Falha ao buscar tags');
    }
    return response.json();
  },

  createTag: async (tag: string, contactIds: string[] = []): Promise<{ tag: string; tags: string[] }> => {
    const response = await fetch('/api/contacts/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, contactIds }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao criar tag');
    }
    return response.json();
  },

  renameTag: async (from: string, to: string): Promise<{ updated: number; tags: string[] }> => {
    const response = await fetch('/api/contacts/tags', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao renomear tag');
    }
    return response.json();
  },

  deleteTag: async (tag: string): Promise<{ updated: number; tags: string[] }> => {
    const response = await fetch('/api/contacts/tags', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao excluir tag');
    }
    return response.json();
  },

  bulkUpdateTags: async (
    contactIds: string[],
    tag: string,
    action: 'add' | 'remove'
  ): Promise<{ updated: number; notFound: string[] }> => {
    const response = await fetch('/api/contacts/bulk-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds, tag, action }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao atualizar tags');
    }
    return response.json();
  },

  getLists: async (): Promise<import('../types').ContactList[]> => {
    const response = await fetch('/api/contacts/lists', { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Falha ao buscar listas');
    }
    const data = await response.json();
    return data.lists || [];
  },

  createList: async (dto: {
    name: string;
    color?: string;
    description?: string | null;
  }): Promise<import('../types').ContactList> => {
    const response = await fetch('/api/contacts/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao criar lista');
    }
    return response.json();
  },

  updateList: async (
    id: string,
    dto: { name?: string; color?: string; description?: string | null }
  ): Promise<import('../types').ContactList> => {
    const response = await fetch(`/api/contacts/lists/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao atualizar lista');
    }
    return response.json();
  },

  deleteList: async (id: string): Promise<void> => {
    const response = await fetch(`/api/contacts/lists/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao excluir lista');
    }
  },

  addListMembers: async (
    listId: string,
    contactIds: string[]
  ): Promise<{ added: number }> => {
    const response = await fetch(`/api/contacts/lists/${listId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao adicionar à lista');
    }
    return response.json();
  },

  removeListMembers: async (
    listId: string,
    contactIds: string[]
  ): Promise<{ removed: number }> => {
    const response = await fetch(`/api/contacts/lists/${listId}/members`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contactIds }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao remover da lista');
    }
    return response.json();
  },

  getListMemberIds: async (listId: string): Promise<string[]> => {
    const response = await fetch(`/api/contacts/lists/${listId}/member-ids`, {
      cache: 'no-store',
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || 'Falha ao buscar membros da lista');
    }
    const data = await response.json();
    return data.contactIds || [];
  },

  list: async (params: ContactListParams): Promise<ContactListResult> => {
    const searchParams = new URLSearchParams();
    searchParams.set('limit', String(params.limit));
    searchParams.set('offset', String(params.offset));
    if (params.search) searchParams.set('search', params.search);
    if (params.status && params.status !== 'ALL') searchParams.set('status', params.status);
    if (params.tag && params.tag !== 'ALL') searchParams.set('tag', params.tag);
    if (params.listId && params.listId !== 'ALL') searchParams.set('listId', params.listId);

    const response = await fetch(`/api/contacts?${searchParams.toString()}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Falha ao buscar contatos');
    }
    return response.json();
  },

  getIds: async (params: { search?: string; status?: string; tag?: string; listId?: string }): Promise<string[]> => {
    const searchParams = new URLSearchParams();
    if (params.search) searchParams.set('search', params.search);
    if (params.status && params.status !== 'ALL') searchParams.set('status', params.status);
    if (params.tag && params.tag !== 'ALL') searchParams.set('tag', params.tag);
    if (params.listId && params.listId !== 'ALL') searchParams.set('listId', params.listId);

    const qs = searchParams.toString();
    const response = await fetch(`/api/contacts/ids${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('Falha ao buscar IDs de contatos');
    }
    return response.json();
  },

  /**
   * Add a single contact with phone validation
   */
  add: async (contact: Omit<Contact, 'id' | 'lastActive'>): Promise<Contact> => {
    const { normalized, validation } = processPhoneNumber(contact.phone);

    if (!validation.isValid) {
      logger.warn('Invalid phone number rejected', {
        phone: contact.phone,
        error: validation.error
      });
      throw new Error(validation.error || 'Número de telefone inválido');
    }

    const normalizedContact = {
      ...contact,
      phone: normalized,
    };

    const response = await fetch('/api/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalizedContact),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Falha ao adicionar contato');
    }

    logger.info('Contact added', {
      name: contact.name,
      phone: normalized
    });

    return response.json();
  },

  /**
   * Validate a phone number without saving
   */
  validatePhone: (phone: string): { isValid: boolean; error?: string; normalized?: string } => {
    const { normalized, validation } = processPhoneNumber(phone);
    return {
      isValid: validation.isValid,
      error: validation.error,
      normalized: validation.isValid ? normalized : undefined,
    };
  },

  update: async (
    id: string,
    data: (Partial<Omit<Contact, 'id'>> & { email?: string | null })
  ): Promise<Contact | undefined> => {
    if (data.phone) {
      const { normalized, validation } = processPhoneNumber(data.phone);
      if (!validation.isValid) {
        throw new Error(validation.error || 'Número de telefone inválido');
      }
      data.phone = normalized;
    }

    const response = await fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    if (!response.ok) return undefined;
    return response.json();
  },

  /**
   * Import contacts from CSV/TXT file content
   */
  importFromContent: async (
    content: string,
    options?: ParseOptions
  ): Promise<ImportResult> => {
    logger.info('Starting contact import', { contentLength: content.length });

    const parseResult = parseContactsFile(content, options);

    if (!parseResult.success) {
      throw new Error('Falha ao processar arquivo');
    }

    const contactsToImport = parseResult.contacts.map(c => ({
      name: c.name || 'Desconhecido',
      phone: c.phone,
      status: ContactStatus.OPT_IN,
      tags: [] as string[],
    }));

    // Import via API
    const response = await fetch('/api/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: contactsToImport }),
    });

    if (!response.ok) {
      throw new Error('Falha ao importar contatos');
    }

    const { imported } = await response.json();

    const result: ImportResult = {
      imported,
      failed: parseResult.invalidRows.length,
      duplicates: parseResult.duplicates.length,
      report: generateImportReport(parseResult),
    };

    logger.info('Contact import completed', { ...result });

    return result;
  },

  /**
   * Import contacts from File object (browser)
   */
  importFromFile: async (
    file: File,
    options?: ParseOptions
  ): Promise<ImportResult> => {
    const parseResult = await parseContactsFromFile(file, options);

    const contactsToImport = parseResult.contacts.map(c => ({
      name: c.name || 'Desconhecido',
      phone: c.phone,
      status: ContactStatus.OPT_IN,
      tags: [] as string[],
    }));

    const response = await fetch('/api/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: contactsToImport }),
    });

    if (!response.ok) {
      throw new Error('Falha ao importar contatos');
    }

    const { imported } = await response.json();

    return {
      imported,
      failed: parseResult.invalidRows.length,
      duplicates: parseResult.duplicates.length,
      report: generateImportReport(parseResult),
    };
  },

  /**
   * Import contacts with merge strategy
   * - New contacts: inserted
   * - Existing contacts (by phone): updated with merged tags
   */
  import: async (contacts: Omit<Contact, 'id' | 'lastActive'>[]): Promise<{ inserted: number; updated: number }> => {
    const validContacts = contacts
      .map(c => {
        const { normalized, validation } = processPhoneNumber(c.phone);
        if (!validation.isValid) return null;
        return { ...c, phone: normalized };
      })
      .filter((c): c is Omit<Contact, 'id' | 'lastActive'> => c !== null);

    logger.info('Import contacts', {
      total: contacts.length,
      valid: validContacts.length
    });

    const response = await fetch('/api/contacts/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: validContacts }),
    });

    if (!response.ok) {
      throw new Error('Falha ao importar contatos');
    }

    const { inserted, updated } = await response.json();
    return { inserted: inserted || 0, updated: updated || 0 };
  },

  delete: async (id: string): Promise<void> => {
    const response = await fetch(`/api/contacts/${id}`, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Falha ao deletar contato');
    }
  },

  deleteMany: async (ids: string[]): Promise<number> => {
    const response = await fetch('/api/contacts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Falha ao deletar contatos');
    }

    const { deleted } = await response.json();
    return deleted;
  }
};
