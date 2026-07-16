/**
 * AI Providers Configuration
 *
 * Modelos EXATOS conforme especificado pelo usuário.
 * Links de referência:
 * - Google: https://ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
 * - OpenAI: https://ai-sdk.dev/providers/ai-sdk-providers/openai
 * - Anthropic: https://ai-sdk.dev/providers/ai-sdk-providers/anthropic
 * - OpenCode Go: https://opencode.ai/docs/zen/ (gateway OpenAI-compatible)
 */

export type AIProvider = 'google' | 'openai' | 'anthropic' | 'opencode-go';

/** Base URL OpenAI-compatible do OpenCode Go */
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

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

export const AI_PROVIDERS: AIProviderConfig[] = [
    {
        id: 'google',
        name: 'Google (Gemini)',
        icon: '💎',
        models: [
            // Flash primeiro = default (mais rápido e barato)
            { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', description: 'Rápido e responsivo (preview) - RECOMENDADO' },
            { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro Preview', description: 'Modelo mais avançado (preview)' },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Melhor para tarefas complexas' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Rápido e eficiente' },
            { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', description: 'Ultra-rápido, baixo custo' },
        ],
    },
    {
        id: 'openai',
        name: 'OpenAI (GPT)',
        icon: '🤖',
        models: [
            { id: 'gpt-5.2-pro', name: 'GPT-5.2 Pro', description: 'Máxima capacidade (mais recente)' },
            { id: 'gpt-5.2-chat-latest', name: 'GPT-5.2 Chat Latest', description: 'Chat otimizado (mais recente)' },
            { id: 'gpt-5', name: 'GPT-5', description: 'Modelo principal' },
            { id: 'gpt-5-mini', name: 'GPT-5 Mini', description: 'Rápido e econômico' },
            { id: 'gpt-5-nano', name: 'GPT-5 Nano', description: 'Ultra-compacto' },
        ],
    },
    {
        id: 'anthropic',
        name: 'Anthropic (Claude)',
        icon: '🧠',
        models: [
            { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', description: 'Máxima inteligência' },
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Equilíbrio performance/custo' },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Rápido e leve' },
        ],
    },
    {
        id: 'opencode-go',
        name: 'OpenCode Go',
        icon: '⚡',
        models: [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'Rápido e econômico - RECOMENDADO' },
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
    AI_PROVIDERS.find((p) => p.id === 'opencode-go')?.models.map((m) => m.id) ?? []
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

/** Modelos do catálogo OpenCode Go */
export function isOpenCodeGoModel(modelId: string): boolean {
    return OPENCODE_GO_MODEL_IDS.has(modelId);
}
