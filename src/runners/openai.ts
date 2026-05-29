import OpenAI from 'openai';
import type { AgentRunner, AgentRunResult } from './types.js';
import type { TaskSpec } from '../agent_tasks/schema.js';
import { composePrompt, parseFencedOutputs, writeOutputs } from './common.js';

const DEFAULT_MAX_TOKENS = 16_000;

/**
 * Generic OpenAI-compatible runner. Works against the OpenAI API by
 * default; pass `baseURL` to point at DeepSeek, Kimi/Moonshot, Qwen, or
 * any other provider that exposes a compatible `/v1/chat/completions`
 * surface. The agent id surfaced to grading / baselines uses `idPrefix`
 * so reports group runs by provider (e.g. `deepseek/deepseek-chat`).
 */
export interface OpenAIRunnerOptions {
  /** Model id passed to the provider, e.g. `gpt-5.5` or `deepseek-reasoner`. */
  model: string;
  /** Optional display label. */
  label?: string;
  /** Max output tokens (default 16k). */
  maxTokens?: number;
  /** Override API key. */
  apiKey?: string;
  /** Env var to read API key from when `apiKey` is unset. Defaults to `OPENAI_API_KEY`. */
  apiKeyEnvVar?: string;
  /** OpenAI-compatible base URL. Omit for canonical OpenAI. */
  baseURL?: string;
  /** Prefix used in the agent id surfaced to graders/baselines. Defaults to `openai`. */
  idPrefix?: string;
  /**
   * Optional string prepended to the user message before sending. Useful for
   * provider-specific directives (e.g. Qwen3's `/no_think` to disable its
   * reasoning trace and recover output-token budget for the actual answer).
   */
  userPromptPrefix?: string;
}

export function openaiRunner(options: OpenAIRunnerOptions): AgentRunner {
  const envVar = options.apiKeyEnvVar ?? 'OPENAI_API_KEY';
  const apiKey = options.apiKey ?? process.env[envVar];
  if (!apiKey) throw new Error(`${envVar} not set; cannot run ${options.idPrefix ?? 'OpenAI'} agent`);
  const client = new OpenAI({
    apiKey,
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const prefix = options.idPrefix ?? 'openai';
  const id = `${prefix}/${options.model}`;

  return {
    id,
    label: options.label ?? id,

    async run(taskDir: string, spec: TaskSpec): Promise<AgentRunResult> {
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      const { system, user } = composePrompt(taskDir, spec);
      const userMessage = options.userPromptPrefix ? `${options.userPromptPrefix}${user}` : user;

      const resp = await client.chat.completions.create({
        model: options.model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage },
        ],
      });

      const text = resp.choices[0]?.message?.content ?? '';

      const files = parseFencedOutputs(text, spec.outputFiles);
      const { written, missing } = writeOutputs(taskDir, files, spec.outputFiles);

      const warnings: string[] = [];
      for (const f of missing) warnings.push(`agent did not emit expected output file: ${f}`);

      return {
        agentId: id,
        taskId: spec.id,
        startedAt,
        durationMs: Date.now() - startMs,
        tokens: {
          ...(resp.usage?.prompt_tokens !== undefined ? { input: resp.usage.prompt_tokens } : {}),
          ...(resp.usage?.completion_tokens !== undefined ? { output: resp.usage.completion_tokens } : {}),
        },
        outputs: written,
        rawResponse: text,
        warnings,
      };
    },
  };
}
