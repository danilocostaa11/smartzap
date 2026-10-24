/**
 * AI Providers Configuration
 *
 * Providers suportados:
 * - Google Gemini (chave própria, modelos carregados dinamicamente)
 * - OpenAI (chave própria, modelos carregados dinamicamente)
 * - OpenCode Go (gateway OpenAI-compatible — catálogo estático abaixo)
 *
 * Para Google/OpenAI os modelos reais são carregados via
 * GET /api/ai/models?provider=google|openai após configurar a chave.
 */

export type AIProvider = 'google' | 'openai' | 'opencode_go';

export interface AIModel {
    id: string;
    name: string;
    description?: string;
}

export interface AIProviderConfig {
    id: AIProvider;
    name: string;
    icon: string;
    models: AIModel[];
}

// =============================================================================
// OpenCode Go (gateway OpenAI-compatible)
// =============================================================================

/**
 * Base URL OpenAI-compatible do OpenCode Go.
 * Pode ser sobrescrita via env `OPENCODE_GO_BASE_URL` (lida no servidor).
 */
export const OPENCODE_GO_BASE_URL_DEFAULT = 'https://opencode.ai/zen/go/v1';

/**
 * Modelo padrão recomendado do OpenCode Go.
 * Constante única e fácil de trocar.
 */
export const OPENCODE_GO_DEFAULT_MODEL = 'claude-haiku-5-5';

/** Resolve a base URL do OpenCode Go (env tem prioridade). Server-side. */
export function resolveOpenCodeGoBaseUrl(): string {
    return process.env.OPENCODE_GO_BASE_URL?.trim() || OPENCODE_GO_BASE_URL_DEFAULT;
}

// =============================================================================
// Protocolo por modelo (o catálogo OpenCode Go mistura protocolos)
// =============================================================================

export type OpenCodeGoProtocol = 'anthropic' | 'responses' | 'chat';

/**
 * Modelos que falam o protocolo Anthropic Messages (`<base>/messages`).
 * Criados com `createAnthropic({ apiKey, baseURL }).languageModel(id)`.
 */
const OPENCODE_GO_ANTHROPIC_MODELS = new Set<string>([
    'claude-haiku-5-5',
    'minimax-m3',
    'qwen3.8-max',
    'qwen3.8-flash',
    'qwen3.7-plus',
]);

/**
 * Modelos que falam o protocolo OpenAI Responses (`createOpenAI(...).responses(id)`).
 * Não listados no catálogo abaixo (não os expomos na UI), mas o roteamento é correto
 * caso um id livre seja salvo.
 */
const OPENCODE_GO_RESPONSES_MODELS = new Set<string>([
    'grok-4.7',
    'gpt-6-luna',
    'gpt-5.6-luna',
    'muse-spark-1.3-contributor',
    'muse-spark-1.2-contributor',
]);

/**
 * Aliases de compatibilidade: ids antigos salvos em agentes → id atual do catálogo.
 */
const OPENCODE_GO_MODEL_ALIASES: Record<string, string> = {
    'deepseek-v4-flash': 'deepseek-v4.1-flash',
};

/** Normaliza um id de modelo OpenCode Go (resolve aliases de compat). */
export function normalizeOpenCodeGoModel(modelId: string): string {
    return OPENCODE_GO_MODEL_ALIASES[modelId] || modelId;
}

/** Decide qual protocolo usar para um modelo OpenCode Go. */
export function resolveOpenCodeGoProtocol(modelId: string): OpenCodeGoProtocol {
    const id = normalizeOpenCodeGoModel(modelId);
    if (OPENCODE_GO_ANTHROPIC_MODELS.has(id)) return 'anthropic';
    if (OPENCODE_GO_RESPONSES_MODELS.has(id)) return 'responses';
    return 'chat';
}

export interface OpenCodeGoModelOpts {
    /** Sessão estável por conversa (ex.: id da conversa do inbox). Omitir se ausente. */
    sessionId?: string;
}

/**
 * Cria o LanguageModel correto para um modelo OpenCode Go, respeitando o protocolo:
 * - anthropic → `createAnthropic({ apiKey, baseURL }).languageModel(id)` (POST <base>/messages)
 * - responses → `createOpenAI({ apiKey, baseURL }).responses(id)`
 * - chat      → `createOpenAI({ apiKey, baseURL }).chat(id)` (POST <base>/chat/completions)
 *
 * Envia sempre `User-Agent: smartzap/1.0` e, quando disponível, `x-opencode-session`.
 */
export async function createOpenCodeGoModel(modelId: string, apiKey: string, opts?: OpenCodeGoModelOpts) {
    const id = normalizeOpenCodeGoModel(modelId);
    const protocol = resolveOpenCodeGoProtocol(id);
    const baseURL = resolveOpenCodeGoBaseUrl();

    const headers: Record<string, string> = { 'User-Agent': 'smartzap/1.0' };
    if (opts?.sessionId) headers['x-opencode-session'] = opts.sessionId;

    if (protocol === 'anthropic') {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({ apiKey, baseURL, headers }).languageModel(id);
    }

    const { createOpenAI } = await import('@ai-sdk/openai');
    const client = createOpenAI({ apiKey, baseURL, headers });
    return protocol === 'responses' ? client.responses(id) : client.chat(id);
}

export const AI_PROVIDERS: AIProviderConfig[] = [
    {
        id: 'google',
        name: 'Google (Gemini)',
        icon: '💎',
        models: [
            { id: 'gemini-flash-latest', name: 'Gemini Flash (sempre atual)', description: 'Alias auto-atualizado — recomendado' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Rápido e eficiente' },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Melhor para tarefas complexas' },
        ],
    },
    {
        id: 'openai',
        name: 'OpenAI (GPT)',
        icon: '🤖',
        models: [
            { id: 'gpt-4o', name: 'GPT-4o', description: 'Modelo principal' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Rápido e econômico' },
        ],
    },
    {
        id: 'opencode_go',
        name: 'OpenCode Go',
        icon: '⚡',
        models: [
            // Padrão recomendado no topo (default). Trocar via OPENCODE_GO_DEFAULT_MODEL.
            { id: OPENCODE_GO_DEFAULT_MODEL, name: 'Claude Haiku 5.5', description: 'Rápido e econômico — RECOMENDADO' },
            { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', description: 'Rápido e econômico (exige região Global)' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Alta capacidade (exige região Global)' },
            { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', description: 'Zhipu GLM rápido' },
            { id: 'glm-5.3', name: 'GLM 5.3', description: 'Zhipu GLM recente' },
            { id: 'glm-5.2', name: 'GLM 5.2', description: 'Zhipu GLM' },
            { id: 'kimi-k3', name: 'Kimi K3', description: 'Modelo Kimi atual' },
            { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', description: 'Otimizado para código' },
            { id: 'minimax-m3', name: 'MiniMax M3', description: 'Equilíbrio custo/qualidade' },
            { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', description: 'Leve e rápido' },
            { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', description: 'Qwen rápido' },
            { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', description: 'Qwen equilibrado' },
            { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', description: 'MiMo rápido' },
            { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', description: 'MiMo pro' },
            { id: 'hy3', name: 'HY3', description: 'Tencent Hunyuan' },
        ],
    },
];

const OPENCODE_GO_MODEL_IDS = new Set(
    AI_PROVIDERS.find((p) => p.id === 'opencode_go')?.models.map((m) => m.id) ?? []
);

/**
 * Get provider config by ID
 */
export function getProvider(providerId: AIProvider): AIProviderConfig | undefined {
    return AI_PROVIDERS.find(p => p.id === providerId);
}

/**
 * Get model config by ID
 */
export function getModel(providerId: AIProvider, modelId: string): AIModel | undefined {
    const provider = getProvider(providerId);
    return provider?.models.find(m => m.id === modelId);
}

/**
 * Get default model for a provider
 */
export function getDefaultModel(providerId: AIProvider): AIModel | undefined {
    const provider = getProvider(providerId);
    return provider?.models[0];
}

/** Modelos do catálogo OpenCode Go (sugestões — ids livres também são aceitos). */
export function isOpenCodeGoModel(modelId: string): boolean {
    return OPENCODE_GO_MODEL_IDS.has(normalizeOpenCodeGoModel(modelId));
}

/**
 * Resolve o id de modelo a usar quando o provider é OpenCode Go.
 * Ids de outros provedores (ex.: DEFAULT_MODEL_ID `gemini-*`, `gpt-4o*`) salvos
 * antes da troca de provider caem no padrão do OpenCode Go em vez de irem para o
 * gateway com um id inválido — e nunca são roteados para Google/OpenAI.
 */
export function resolveOpenCodeGoModelId(modelId?: string | null): string {
    const id = (modelId || '').trim();
    if (!id) return resolveOpenCodeGoDefaultModel();
    const isOtherProvider = AI_PROVIDERS.some(
        (p) => p.id !== 'opencode_go' && p.models.some((m) => m.id === id)
    ) || /^gemini-|^gpt-4o/.test(id);
    if (isOtherProvider) return resolveOpenCodeGoDefaultModel();
    return normalizeOpenCodeGoModel(id);
}

/** Padrão do OpenCode Go, sobrescrevível por env OPENCODE_GO_DEFAULT_MODEL. */
export function resolveOpenCodeGoDefaultModel(): string {
    return process.env.OPENCODE_GO_DEFAULT_MODEL?.trim() || OPENCODE_GO_DEFAULT_MODEL;
}
