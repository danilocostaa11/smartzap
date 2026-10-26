/**
 * Factory única de LanguageModel para os providers diretos (Google / OpenAI / OpenCode Go).
 *
 * Centraliza a escolha de provider + resolução do id de modelo que antes era
 * copiada em cada rota. Garante que:
 * - o provider é SEMPRE o explícito em Configurações → IA (sem detecção por id);
 * - OpenCode Go roteia pelo protocolo certo e normaliza ids de outros providers
 *   (`resolveOpenCodeGoModelId`), devolvendo o id REALMENTE usado em `modelId` —
 *   necessário para decisões por modelo como `resolveTemperature`.
 *
 * Os SDKs são importados dinamicamente: alguns chamadores rodam em contexto de
 * background (webhook com debounce), onde imports estáticos causavam problemas.
 */

import type { LanguageModel } from 'ai'

import type { AiDirectConfig, AiProviderType } from './ai-center-defaults'
import { DEFAULT_MODEL_ID } from './model'
import { createOpenCodeGoModel, resolveOpenCodeGoModelId } from './providers'

export interface DirectModelOptions {
  /** Sessão estável por conversa (OpenCode Go: header `x-opencode-session`). */
  sessionId?: string
}

export interface DirectModel {
  model: LanguageModel
  /** Id de modelo efetivamente enviado ao provider (já resolvido/normalizado). */
  modelId: string
  provider: AiProviderType
}

const PROVIDER_LABELS: Record<AiProviderType, string> = {
  google: 'Google',
  openai: 'OpenAI',
  opencode_go: 'OpenCode Go',
}

/**
 * Cria o modelo para o provider configurado.
 *
 * @param config Configuração de provider direto (`getAiDirectConfig()`).
 * @param requestedModelId Id salvo no agente/chamada; cai em `config.model` → `DEFAULT_MODEL_ID`.
 * @throws Error legível (`Chave <provider> não configurada...`) quando falta a chave do provider ativo.
 */
export async function createDirectModel(
  config: AiDirectConfig,
  requestedModelId?: string | null,
  opts?: DirectModelOptions,
): Promise<DirectModel> {
  const baseModelId = requestedModelId || config.model || DEFAULT_MODEL_ID
  const provider = config.provider

  if (provider === 'opencode_go') {
    if (!config.opencodeGoApiKey) throw missingKeyError(provider)
    const modelId = resolveOpenCodeGoModelId(baseModelId)
    const model = await createOpenCodeGoModel(modelId, config.opencodeGoApiKey, { sessionId: opts?.sessionId })
    return { model, modelId, provider }
  }

  if (provider === 'openai') {
    if (!config.openaiApiKey) throw missingKeyError(provider)
    const { createOpenAI } = await import('@ai-sdk/openai')
    return { model: createOpenAI({ apiKey: config.openaiApiKey })(baseModelId), modelId: baseModelId, provider }
  }

  if (!config.googleApiKey) throw missingKeyError('google')
  const { createGoogleGenerativeAI } = await import('@ai-sdk/google')
  return {
    model: createGoogleGenerativeAI({ apiKey: config.googleApiKey })(baseModelId),
    modelId: baseModelId,
    provider: 'google',
  }
}

function missingKeyError(provider: AiProviderType): Error {
  return new Error(`Chave ${PROVIDER_LABELS[provider]} não configurada. Acesse Configurações → IA.`)
}
