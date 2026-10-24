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
 * Constante única e fácil de trocar. (id a confirmar)
 */
export const OPENCODE_GO_DEFAULT_MODEL = 'claude-haiku-5-5';

/** Resolve a base URL do OpenCode Go (env tem prioridade). Server-side. */
export function resolveOpenCodeGoBaseUrl(): string {
    return process.env.OPENCODE_GO_BASE_URL?.trim() || OPENCODE_GO_BASE_URL_DEFAULT;
}

/**
 * Cria modelo de chat OpenCode Go via Chat Completions API.
 *
 * @ai-sdk/openai v3 usa Responses API em `client(modelId)` → 404 no Zen Go.
 * OpenCode Go só expõe `/v1/chat/completions` — use SEMPRE `.chat(modelId)`.
 */
export async function createOpenCodeGoChatModel(modelId: string, apiKey: string) {
    const { createOpenAI } = await import('@ai-sdk/openai');
    return createOpenAI({ apiKey, baseURL: resolveOpenCodeGoBaseUrl() }).chat(modelId);
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
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Rápido e econômico' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', description: 'Alta capacidade' },
            { id: 'minimax-m3', name: 'MiniMax M3', description: 'Modelo aberto recente' },
            { id: 'minimax-m2.7', name: 'MiniMax M2.7', description: 'Equilíbrio custo/qualidade' },
            { id: 'minimax-m2.5', name: 'MiniMax M2.5', description: 'Leve e rápido' },
            { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', description: 'Otimizado para código' },
            { id: 'kimi-k2.6', name: 'Kimi K2.6', description: 'Modelo Kimi atual' },
            { id: 'kimi-k2.5', name: 'Kimi K2.5', description: 'Kimi econômico' },
            { id: 'glm-5.2', name: 'GLM 5.2', description: 'Zhipu GLM recente' },
            { id: 'glm-5.1', name: 'GLM 5.1', description: 'Zhipu GLM' },
            { id: 'glm-5', name: 'GLM 5', description: 'Zhipu GLM base' },
            { id: 'qwen3.7-max', name: 'Qwen3.7 Max', description: 'Máxima capacidade Qwen' },
            { id: 'qwen3.7-plus', name: 'Qwen3.7 Plus', description: 'Qwen equilibrado' },
            { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', description: 'Qwen plus' },
            { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', description: 'Qwen econômico' },
            { id: 'mimo-v2-pro', name: 'MiMo V2 Pro', description: 'MiMo pro' },
            { id: 'mimo-v2-omni', name: 'MiMo V2 Omni', description: 'MiMo omni' },
            { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', description: 'MiMo 2.5 pro' },
            { id: 'mimo-v2.5', name: 'MiMo V2.5', description: 'MiMo 2.5' },
            { id: 'hy3-preview', name: 'HY3 Preview', description: 'Preview' },
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
    return OPENCODE_GO_MODEL_IDS.has(modelId);
}
