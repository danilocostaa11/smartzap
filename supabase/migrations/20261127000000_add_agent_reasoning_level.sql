-- Migration: Add reasoning_level to ai_agents
-- Purpose: nível de raciocínio (thinkingLevel) por agente, aplicado só em modelos Gemini 3.x.
-- NULL = padrão do modelo (comportamento atual de todos os agentes existentes).
-- Idempotente (IF NOT EXISTS); não altera nenhuma linha existente.

ALTER TABLE ai_agents
ADD COLUMN IF NOT EXISTS reasoning_level TEXT
  CHECK (reasoning_level IS NULL OR reasoning_level IN ('minimal', 'low', 'medium', 'high'));

COMMENT ON COLUMN ai_agents.reasoning_level IS 'Nível de raciocínio (Gemini 3.x thinkingLevel). NULL = padrão do modelo';
