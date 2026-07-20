-- Listas estáticas de contatos (audiência salva para disparos)

CREATE TABLE IF NOT EXISTS public.contact_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6B7280'::text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_lists_pkey PRIMARY KEY (id),
    CONSTRAINT contact_lists_name_unique UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS public.contact_list_members (
    list_id uuid NOT NULL,
    contact_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT contact_list_members_pkey PRIMARY KEY (list_id, contact_id),
    CONSTRAINT contact_list_members_list_id_fkey
        FOREIGN KEY (list_id) REFERENCES public.contact_lists(id) ON DELETE CASCADE,
    CONSTRAINT contact_list_members_contact_id_fkey
        FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS contact_list_members_contact_id_idx
    ON public.contact_list_members (contact_id);

CREATE OR REPLACE FUNCTION public.update_contact_lists_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS update_contact_lists_updated_at_trigger ON public.contact_lists;
CREATE TRIGGER update_contact_lists_updated_at_trigger
    BEFORE UPDATE ON public.contact_lists
    FOR EACH ROW
    EXECUTE FUNCTION public.update_contact_lists_updated_at();
