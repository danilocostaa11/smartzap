/**
 * Serviço de IA unificado — providers diretos (Google Gemini / OpenAI).
 *
 * Usa as chaves de API do próprio usuário, armazenadas no Supabase.
 * Cada cliente paga diretamente ao provider — sem intermediação da Vercel.
 *
 * Exemplo:
 * - `import { ai } from '@/lib/ai'`
 * - `const result = await ai.generateText({ prompt: 'Olá' })`
 */

import { generateText as vercelGenerateText, streamText as vercelStreamText, type ModelMessage, type LanguageModel } from 'ai'

import { getAiDirectConfig } from './ai-center-config'
import { createDirectModel, type DirectModel } from './direct-model'
import { resolveTemperature } from './model-capabilities'

// =============================================================================
// TYPES
// =============================================================================

/** Alias para compatibilidade retroativa. */
export type ChatMessage = {
    role: 'user' | 'assistant' | 'system';
    content: string;
}

export interface GenerateTextOptions {
    /** Prompt simples (mutuamente exclusivo com `messages`). */
    prompt?: string;
    /** Mensagens da conversa (mutuamente exclusivo com `prompt`). */
    messages?: ChatMessage[];
    /** Instrução de sistema (contexto) enviada ao modelo. */
    system?: string;
    /** Sobrescreve o modelo configurado nas settings (formato bare, ex: 'gemini-2.5-flash'). */
    model?: string;
    /** Máximo de tokens de saída. */
    maxOutputTokens?: number;
    /** Temperatura (geralmente entre 0 e 2). */
    temperature?: number;
}

export interface StreamTextOptions extends GenerateTextOptions {
    /** Callback chamado a cada chunk de texto recebido. */
    onChunk?: (chunk: string) => void;
    /** Callback chamado quando o streaming terminar, com o texto completo. */
    onComplete?: (text: string) => void;
}

export interface GenerateTextResult {
    text: string;
    model: string;
}

// =============================================================================
// PROVIDER FACTORY
// =============================================================================

/**
 * Cria a instância do modelo de linguagem com base na configuração de provider.
 * Lança erro se a chave do provider não estiver configurada.
 * Delegado a `createDirectModel` (factory única, compartilhada com as rotas de chat).
 */
async function createModelInstance(modelOverride?: string): Promise<DirectModel> {
    const config = await getAiDirectConfig()
    const direct = await createDirectModel(config, modelOverride)
    return direct
}

// =============================================================================
// ERROR HANDLING
// =============================================================================

/**
 * Converte erros de provider em mensagens legíveis.
 * Trata 401 (chave inválida), 429 (rate limit) e 503 (serviço indisponível).
 */
function handleProviderError(error: unknown, modelId: string): never {
    if (error && typeof error === 'object' && 'statusCode' in error) {
        const status = (error as { statusCode: number }).statusCode
        switch (status) {
            case 401:
                throw new Error(`[IA] Chave de API inválida para ${modelId}. Verifique nas configurações de IA.`)
            case 429:
                throw new Error(`[IA] Rate limit atingido para ${modelId}. Tente novamente em alguns segundos.`)
            case 503:
                throw new Error(`[IA] Serviço temporariamente indisponível para ${modelId}. Tente novamente em breve.`)
        }
    }
    throw error
}

type CallArgs =
    | { model: LanguageModel; system: string | undefined; temperature?: number; maxOutputTokens?: number; messages: ModelMessage[] }
    | { model: LanguageModel; system: string | undefined; temperature?: number; maxOutputTokens?: number; prompt: string }

function buildArgs(
    options: GenerateTextOptions,
    { model, modelId }: DirectModel,
): CallArgs {
    const base = {
        model,
        system: options.system,
        // Omitida (undefined) para modelos que rejeitam `temperature` (Claude 5.x+).
        temperature: resolveTemperature(modelId, options.temperature),
        ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}),
    }
    return (options.messages
        ? { ...base, messages: options.messages as unknown as ModelMessage[] }
        : { ...base, prompt: options.prompt || '' }) as CallArgs
}

// =============================================================================
// MAIN API
// =============================================================================

/**
 * Gera texto usando o provider configurado (Google Gemini ou OpenAI).
 *
 * A chave de API é lida do Supabase — configurada pelo usuário nas settings de IA.
 */
export async function generateText(options: GenerateTextOptions): Promise<GenerateTextResult> {
    const direct = await createModelInstance(options.model)
    const { modelId, provider } = direct
    console.log(`[AI Service] Generating with ${provider}/${modelId}`)

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await vercelGenerateText(buildArgs(options, direct) as any)
        return { text: result.text, model: modelId }
    } catch (error) {
        handleProviderError(error, modelId)
    }
}

/**
 * Gera texto em streaming usando o provider configurado.
 */
export async function streamText(options: StreamTextOptions): Promise<GenerateTextResult> {
    const direct = await createModelInstance(options.model)
    const { modelId, provider } = direct
    console.log(`[AI Service] Streaming with ${provider}/${modelId}`)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = vercelStreamText(buildArgs(options, direct) as any)

    let fullText = ''
    try {
        for await (const part of result.textStream) {
            fullText += part
            options.onChunk?.(part)
        }
    } catch (error) {
        handleProviderError(error, modelId)
    }

    options.onComplete?.(fullText)
    return { text: fullText, model: modelId }
}

/**
 * Gera uma resposta em JSON via IA.
 *
 * @typeParam T Tipo esperado do JSON retornado.
 */
export async function generateJSON<T = unknown>(options: GenerateTextOptions): Promise<T> {
    const result = await generateText({
        ...options,
        system: (options.system || '') + '\n\nRespond with valid JSON only, no markdown.',
    })

    try {
        const cleanText = result.text
            .replace(/```json\n?/g, '')
            .replace(/```\n?/g, '')
            .trim()

        try {
            return JSON.parse(cleanText) as T
        } catch {
            const extracted = extractFirstJsonValue(cleanText)
            if (extracted) {
                return JSON.parse(extracted) as T
            }
            throw new Error('AI response was not valid JSON')
        }
    } catch {
        console.error('[AI Service] Failed to parse JSON response:', result.text)
        throw new Error('AI response was not valid JSON')
    }
}

/**
 * Limpa o cache de settings de IA (compatibilidade retroativa).
 */
export function clearSettingsCache() {
    // No-op: cache é gerenciado pela camada de configuração
}

// =============================================================================
// JSON EXTRACTION (fallback)
// =============================================================================

function extractFirstJsonValue(text: string): string | null {
    const start = Math.min(
        ...['{', '[']
            .map((c) => text.indexOf(c))
            .filter((i) => i >= 0)
    )

    if (!Number.isFinite(start) || start < 0) return null

    const open = text[start]
    const close = open === '{' ? '}' : ']'

    let depth = 0
    let inString = false
    let escaped = false

    for (let i = start; i < text.length; i += 1) {
        const ch = text[i]

        if (inString) {
            if (escaped) { escaped = false; continue }
            if (ch === '\\') { escaped = true; continue }
            if (ch === '"') { inString = false }
            continue
        }

        if (ch === '"') { inString = true; continue }
        if (ch === open) depth += 1
        if (ch === close) depth -= 1

        if (depth === 0) {
            return text.slice(start, i + 1).trim()
        }
    }

    return null
}

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

export const ai = {
    generateText,
    streamText,
    generateJSON,
    clearSettingsCache,
}

export default ai

// Re-export types and providers (compatibilidade retroativa)
export { AI_PROVIDERS, getProvider, getModel, getDefaultModel } from './providers'
export type { AIProvider, AIModel, AIProviderConfig } from './providers'
