# Nova instância SmartZap por número de WhatsApp

Decisão: **um SmartZap por número** (LIA-01 agora; LIA-02 e LIA-03 depois).
Cada número tem seu próprio projeto Vercel, banco Supabase e Redis Upstash.
Nada é compartilhado entre instâncias, exceto o QStash da conta Upstash (opcional).

> Regras de ouro
> - Nenhum token, senha ou PIN em arquivo, commit, chat ou log.
> - O webhook é configurado **por número** (override). **Nunca** altere o webhook
>   do app nem o `subscribed_apps` da WABA: isso afeta todos os outros números.
> - Nada de mensagem de teste até o nome de exibição sair de `PENDING_REVIEW` e
>   haver ok explícito do dono.

## 1. Convenção de nomes

| Recurso | Nome | Observação |
|---|---|---|
| Projeto Vercel | `smartzap-<slug>` (ex.: `smartzap-lia`, `smartzap-lia-02`) | URL `https://smartzap-<slug>.vercel.app` |
| Supabase | `smartzap-<slug>` | região `sa-east-1` (São Paulo) |
| Upstash Redis | `smartzap-<slug>` | região `sa-east-1` ou a mais próxima |
| Upstash QStash | o da conta | um token por conta; pode ser reaproveitado |

Registre cada instância no ledger de números (número, `phone_number_id`, WABA, projeto Vercel, URL).

## 2. Projeto Vercel

Pelo script (recomendado):

```bash
export VERCEL_TOKEN=...            # nunca commitar
export VERCEL_SCOPE=<time-ou-conta>
scripts/nova-instancia.sh create lia sync-upstream-20261024   # slug, branch
```

Ou manualmente no painel: *Add New → Project → importar `danilocostaa11/smartzap`*,
nome `smartzap-<slug>`, framework Next.js, região de funções `gru1`, e:

- **Ignored Build Step**: `if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 0; else exit 1; fi`
  (enquanto `main` não estiver atualizada; remova depois do merge).
- **Deployment Protection**: desligada para produção (a Meta precisa alcançar `/api/webhook`).
- **System Environment Variables**: expostas (padrão). O instalador usa `VERCEL_PROJECT_ID`
  para gravar **somente** neste projeto.

### Variáveis de ambiente (nomes; valores nunca neste arquivo)

Definidas antes do primeiro deploy:

| Nome | Valor |
|---|---|
| `INSTALLER_ENABLED` | `true` (o instalador se bloqueia sozinho depois que `MASTER_PASSWORD` existe) |
| `OPENCODE_GO_BASE_URL` | `https://opencode.ai/zen/go/v1` |
| `OPENCODE_GO_DEFAULT_MODEL` | `claude-haiku-5-5` |

Gravadas pelo instalador (`/install`), não precisa criar à mão:

`MASTER_PASSWORD`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`,
`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `VERCEL_API_TOKEN`, `SMARTZAP_API_KEY`,
`SETUP_COMPLETE`.

Opcionais: `OPENCODE_GO_API_KEY` (preferir colar em Configurações → IA), `GEMINI_API_KEY`
(embeddings do RAG; também pode ir em Configurações → IA), `WEBHOOK_VERIFY_TOKEN`
(se ausente, o SmartZap gera e guarda no banco).

## 3. Contas e tokens que o dono precisa ter

1. **Vercel token**: https://vercel.com/account/tokens, escopo do time onde está o projeto.
2. **Supabase Personal Access Token**: https://supabase.com/dashboard/account/tokens
   (o instalador cria o projeto `smartzap-<slug>` e roda as migrações).
3. **Upstash**: https://console.upstash.com
   - QStash → copiar `QSTASH_TOKEN`.
   - Redis → *Create database* `smartzap-<slug>` → copiar REST URL e REST TOKEN.
4. **OpenCode Go**: https://opencode.ai → Console → assinar Go → copiar API key.
5. **Google AI Studio (embeddings do RAG)**: https://aistudio.google.com/apikey.

## 4. Instalação (cria Supabase e roda as migrações)

1. Abrir `https://smartzap-<slug>.vercel.app/install`.
2. Colar os tokens do item 3 **direto no formulário** (nunca no chat).
3. Escolher criar novo projeto Supabase `smartzap-<slug>` em `sa-east-1`.
4. O instalador roda todas as migrações de `supabase/migrations`, grava as envs
   no projeto Vercel deste deploy e faz o redeploy.
5. Definir a senha mestra quando pedir. Depois disso `/install` fica bloqueado.

Alternativa manual às migrações (se o wizard falhar):

```bash
supabase link --project-ref <ref>
supabase db push            # aplica supabase/migrations em ordem
```

## 5. Conectar o número (Configurações → WhatsApp)

- `Phone Number ID`: o `phone_number_id` do número (ex.: LIA-01 = `1301856789688407`).
- `Business Account ID`: a WABA (ex.: `532883773244028`).
- `Access Token`: token **permanente** de System User (item 6), colado direto na UI.

## 6. Token permanente de System User

1. https://business.facebook.com/settings/system-users
2. Selecionar o System User (ex.: "Danilo") ou *Adicionar* um novo (função Admin).
3. *Atribuir ativos* → Contas do WhatsApp → **somente** a WABA do número →
   controle total (gerenciar).
4. *Gerar novo token* → app da WABA → validade **Nunca** → permissões
   `whatsapp_business_messaging` e `whatsapp_business_management`.
5. Copiar e colar **direto** em Configurações → WhatsApp do SmartZap. Não salvar em
   arquivo, não enviar por chat.

## 7. Webhook POR NÚMERO (override)

Preferencial, pela própria UI: Configurações → Webhook → número → *Ativar override*
com a URL `https://smartzap-<slug>.vercel.app/api/webhook`. O SmartZap faz o preflight
(GET com `hub.verify_token`) e chama a Graph API com o token salvo.

Equivalente via Graph API (só para este número):

```bash
curl -X POST "https://graph.facebook.com/v23.0/<PHONE_NUMBER_ID>" \
  -H "Authorization: Bearer $WHATSAPP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"webhook_configuration":{"override_callback_uri":"https://smartzap-<slug>.vercel.app/api/webhook","verify_token":"'"$VERIFY_TOKEN"'"}}'
```

Conferir: `GET https://graph.facebook.com/v23.0/<PHONE_NUMBER_ID>?fields=webhook_configuration`.

Reverter (volta a usar o webhook do app): repetir o POST com
`"override_callback_uri": ""`.

**Não** usar `POST /<WABA_ID>/subscribed_apps` com `override_callback_uri` nem mudar o
webhook do app em developers.facebook.com: isso afeta todos os números da WABA.

## 8. IA

- Configurações → IA → provedor **OpenCode Go** → colar a API key → modelo
  `claude-haiku-5-5` (Anthropic Messages; demais modelos via Chat Completions).
- Embeddings do RAG: Google `gemini-embedding-001` (768 dim) → precisa da chave Google.
- O SmartZap envia `User-Agent: smartzap/1.0` e `x-opencode-session` por conversa,
  como o OpenCode Go pede. Atenção: o Go é pensado para agentes de código; monitore uso.

## 9. Canário

1. Nome de exibição aprovado (fora de `PENDING_REVIEW`) e ok do dono.
2. Enviar 1 mensagem de um número de teste para o número da instância.
3. Ver em Inbox a mensagem chegando e a resposta da IA; checar logs na Vercel.
