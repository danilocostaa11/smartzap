#!/usr/bin/env bash
# Cria/atualiza uma instância SmartZap por número (ver docs/nova-instancia-por-numero.md).
# Segredos vêm SEMPRE de variáveis de ambiente e nunca são impressos.
#
#   scripts/nova-instancia.sh create <slug> [branch]
#       requer: VERCEL_TOKEN, VERCEL_SCOPE (time/conta); opcional REPO (padrão danilocostaa11/smartzap)
#   scripts/nova-instancia.sh webhook-override <phone_number_id> <callback_url>
#       requer: WHATSAPP_TOKEN, VERIFY_TOKEN
#   scripts/nova-instancia.sh webhook-status <phone_number_id>
#       requer: WHATSAPP_TOKEN
set -euo pipefail

GRAPH="https://graph.facebook.com/${META_API_VERSION:-v23.0}"
REPO="${REPO:-danilocostaa11/smartzap}"

need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "faltando env: $v" >&2; exit 1; }; done; }

vercel_api() { # método caminho [json]
  local method=$1 path=$2 body=${3:-}
  curl -sS -X "$method" "https://api.vercel.com${path}" \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" -H "Content-Type: application/json" \
    ${body:+-d "$body"}
}

team_qs() { [[ "${VERCEL_SCOPE}" == team_* ]] && echo "teamId=${VERCEL_SCOPE}" || echo "slug=${VERCEL_SCOPE}"; }

cmd_create() {
  need VERCEL_TOKEN VERCEL_SCOPE
  local slug=${1:?slug}; local branch=${2:-main}; local name="smartzap-${slug}"
  local qs; qs=$(team_qs)
  local owner=${REPO%%/*} repo=${REPO##*/}

  if vercel_api GET "/v9/projects/${name}?${qs}" | grep -q "\"name\":\"${name}\""; then
    echo "projeto ${name} já existe (idempotente)"
  else
    local ignore='if [ \"$VERCEL_GIT_COMMIT_REF\" = \"main\" ]; then exit 0; else exit 1; fi'
    vercel_api POST "/v11/projects?${qs}" "{
      \"name\":\"${name}\",\"framework\":\"nextjs\",
      \"gitRepository\":{\"type\":\"github\",\"repo\":\"${REPO}\"},
      \"serverlessFunctionRegion\":\"gru1\",\"ssoProtection\":null,
      \"commandForIgnoringBuildStep\":\"${ignore}\",
      \"environmentVariables\":[
        {\"key\":\"INSTALLER_ENABLED\",\"value\":\"true\",\"target\":[\"production\",\"preview\"],\"type\":\"plain\"},
        {\"key\":\"OPENCODE_GO_BASE_URL\",\"value\":\"https://opencode.ai/zen/go/v1\",\"target\":[\"production\",\"preview\",\"development\"],\"type\":\"plain\"},
        {\"key\":\"OPENCODE_GO_DEFAULT_MODEL\",\"value\":\"claude-haiku-5-5\",\"target\":[\"production\",\"preview\",\"development\"],\"type\":\"plain\"}
      ]}" | grep -o '"id":"prj_[^"]*"' | head -1 || { echo "falha ao criar projeto" >&2; exit 1; }
    echo "projeto ${name} criado"
  fi

  vercel_api POST "/v13/deployments?${qs}&skipAutoDetectionConfirmation=1" "{
    \"name\":\"${name}\",\"project\":\"${name}\",\"target\":\"production\",
    \"gitSource\":{\"type\":\"github\",\"org\":\"${owner}\",\"repo\":\"${repo}\",\"ref\":\"${branch}\"}}" \
    | grep -o '"url":"[^"]*"' | head -1
  echo "Depois do deploy: abra https://${name}.vercel.app/install"
}

cmd_webhook_override() {
  need WHATSAPP_TOKEN VERIFY_TOKEN
  local pnid=${1:?phone_number_id} url=${2:?callback_url}
  # Somente o número. NUNCA mexer em subscribed_apps / webhook do app.
  curl -sS -X POST "${GRAPH}/${pnid}" \
    -H "Authorization: Bearer ${WHATSAPP_TOKEN}" -H "Content-Type: application/json" \
    -d "{\"webhook_configuration\":{\"override_callback_uri\":\"${url}\",\"verify_token\":\"${VERIFY_TOKEN}\"}}"
  echo
}

cmd_webhook_status() {
  need WHATSAPP_TOKEN
  curl -sS "${GRAPH}/${1:?phone_number_id}?fields=display_phone_number,verified_name,name_status,webhook_configuration" \
    -H "Authorization: Bearer ${WHATSAPP_TOKEN}"
  echo
}

case "${1:-}" in
  create) shift; cmd_create "$@" ;;
  webhook-override) shift; cmd_webhook_override "$@" ;;
  webhook-status) shift; cmd_webhook_status "$@" ;;
  *) sed -n 2,12p "$0"; exit 1 ;;
esac
