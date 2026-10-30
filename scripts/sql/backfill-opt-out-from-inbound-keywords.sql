-- ============================================================================
-- Backfill (NÃO É MIGRATION — rodar manualmente, depois de revisar o preview)
--
-- Contexto: até a correção do webhook, uma resposta "Sair"/"parar"/"descadastrar"
-- só gravava a supressão em `phone_suppressions`; `contacts.status` continuava
-- 'Opt-in' e o contador de opt-out ficava em 0. Este script corrige
-- retroativamente os contatos que já pediram opt-out.
--
-- Fontes consideradas:
--   (A) phone_suppressions ativas com source = 'inbound_keyword'
--       (gravadas pelo webhook antigo quando o passo chegou a rodar);
--   (B) mensagens inbound do Inbox cujo texto é um pedido de opt-out
--       (cobre casos em que o webhook pulou o passo de supressão).
--
-- Regras de segurança:
--   - só altera quem está 'Opt-in'/'OPT_IN' (não mexe em status manual);
--   - compara telefone com e sem "+";
--   - a palavra precisa aparecer como palavra inteira (mesma regra do código);
--   - tudo dentro de uma transação; rode o PREVIEW antes e só então o UPDATE.
--
-- Como usar (SQL Editor do Supabase ou psql com service role):
--   1. Rode o bloco PREVIEW e confira a lista.
--   2. Se estiver OK, rode o bloco APPLY (BEGIN ... COMMIT). Para desfazer no
--      meio, troque COMMIT por ROLLBACK.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PREVIEW: quem seria marcado como Opt-out e por qual fonte
-- ---------------------------------------------------------------------------
WITH keyword_pattern AS (
  SELECT
    -- palavras inteiras (PT-BR + EN); acentos removidos via unaccent se disponível
    '(^|[^a-z0-9])(parar|pare|stop|cancelar|cancele|sair|remover|remove|descadastrar|desinscrever|unsubscribe|optout|opt-out|opt out)($|[^a-z0-9])' AS words,
    '(nao quero|nao receber|nao me mande|nao mande mais)' AS phrases
),
from_suppressions AS (
  SELECT DISTINCT
    ltrim(ps.phone, '+') AS phone_digits,
    'phone_suppressions:inbound_keyword'::text AS source,
    ps.last_seen_at AS requested_at
  FROM public.phone_suppressions ps
  WHERE ps.is_active = true
    AND ps.source = 'inbound_keyword'
    AND (ps.expires_at IS NULL OR ps.expires_at > now())
),
from_inbox AS (
  SELECT DISTINCT
    ltrim(c.phone, '+') AS phone_digits,
    'inbox_messages:' || m.id::text AS source,
    m.created_at AS requested_at
  FROM public.inbox_messages m
  JOIN public.inbox_conversations c ON c.id = m.conversation_id
  CROSS JOIN keyword_pattern kp
  WHERE m.direction = 'inbound'
    AND m.message_type IN ('text', 'interactive')
    AND (
      lower(translate(m.content, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) ~ kp.words
      OR lower(translate(m.content, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) ~ kp.phrases
    )
),
requests AS (
  SELECT * FROM from_suppressions
  UNION ALL
  SELECT * FROM from_inbox
)
SELECT
  ct.id,
  ct.name,
  ct.phone,
  ct.status AS current_status,
  min(r.requested_at) AS first_request_at,
  string_agg(DISTINCT r.source, ', ') AS sources
FROM requests r
JOIN public.contacts ct ON ltrim(ct.phone, '+') = r.phone_digits
WHERE ct.status IN ('Opt-in', 'OPT_IN')
GROUP BY ct.id, ct.name, ct.phone, ct.status
ORDER BY first_request_at;

-- ---------------------------------------------------------------------------
-- APPLY: marca como Opt-out (mesma seleção do PREVIEW) e garante a supressão
-- ---------------------------------------------------------------------------
-- BEGIN;
--
-- WITH keyword_pattern AS (
--   SELECT
--     '(^|[^a-z0-9])(parar|pare|stop|cancelar|cancele|sair|remover|remove|descadastrar|desinscrever|unsubscribe|optout|opt-out|opt out)($|[^a-z0-9])' AS words,
--     '(nao quero|nao receber|nao me mande|nao mande mais)' AS phrases
-- ),
-- from_suppressions AS (
--   SELECT DISTINCT ltrim(ps.phone, '+') AS phone_digits
--   FROM public.phone_suppressions ps
--   WHERE ps.is_active = true AND ps.source = 'inbound_keyword'
--     AND (ps.expires_at IS NULL OR ps.expires_at > now())
-- ),
-- from_inbox AS (
--   SELECT DISTINCT ltrim(c.phone, '+') AS phone_digits
--   FROM public.inbox_messages m
--   JOIN public.inbox_conversations c ON c.id = m.conversation_id
--   CROSS JOIN keyword_pattern kp
--   WHERE m.direction = 'inbound'
--     AND m.message_type IN ('text', 'interactive')
--     AND (
--       lower(translate(m.content, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) ~ kp.words
--       OR lower(translate(m.content, 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')) ~ kp.phrases
--     )
-- ),
-- requests AS (
--   SELECT phone_digits FROM from_suppressions
--   UNION
--   SELECT phone_digits FROM from_inbox
-- ),
-- updated AS (
--   UPDATE public.contacts ct
--   SET status = 'Opt-out', updated_at = now()
--   FROM requests r
--   WHERE ltrim(ct.phone, '+') = r.phone_digits
--     AND ct.status IN ('Opt-in', 'OPT_IN')
--   RETURNING ct.phone
-- )
-- -- Garante a supressão para quem veio só do Inbox (idempotente por phone)
-- INSERT INTO public.phone_suppressions (phone, is_active, reason, source, metadata, last_seen_at, expires_at)
-- SELECT
--   CASE WHEN u.phone LIKE '+%' THEN u.phone ELSE '+' || u.phone END,
--   true,
--   'Usuário solicitou opt-out via mensagem inbound (backfill)',
--   'inbound_keyword',
--   jsonb_build_object('backfill', true),
--   now(),
--   NULL
-- FROM updated u
-- ON CONFLICT (phone) DO UPDATE
--   SET is_active = true,
--       last_seen_at = now(),
--       expires_at = NULL;
--
-- -- Confira o número de linhas afetadas e então:
-- COMMIT;   -- ou ROLLBACK;
