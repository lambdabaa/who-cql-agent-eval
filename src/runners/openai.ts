import OpenAI from 'openai';
import type { AgentRunner, AgentRunResult } from './types.js';
import type { TaskSpec } from '../agent_tasks/schema.js';
import { composePrompt, parseFencedOutputs, writeOutputs } from './common.js';

const DEFAULT_MAX_TOKENS = 16_000;

export interface OpenAIRunnerOptions {
  /** Model id, e.g. `gpt-5.5`. */
  model: string;
  /** Optional display label. */
  label?: string;
  /** Max output tokens (default 16k). */
  maxTokens?: number;
  /** Override API key (else uses OPENAI_API_KEY env). */
  apiKey?: string;
}

export function openaiRunner(options: OpenAIRunnerOptions): AgentRunner {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set; cannot run OpenAI agent');
  const client = new OpenAI({ apiKey });
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const id = `openai/${options.model}`;

  return {
    id,
    label: options.label ?? id,

    async run(taskDir: string, spec: TaskSpec): Promise<AgentRunResult> {
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      const { system, user } = composePrompt(taskDir, spec);

      const resp = await client.chat.completions.create({
        model: options.model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
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
