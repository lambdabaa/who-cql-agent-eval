import Anthropic from '@anthropic-ai/sdk';
import type { AgentRunner, AgentRunResult } from './types.js';
import type { TaskSpec } from '../agent_tasks/schema.js';
import { composePrompt, parseFencedOutputs, writeOutputs } from './common.js';

const DEFAULT_MAX_TOKENS = 16_000;

export interface AnthropicRunnerOptions {
  /** Model id, e.g. `claude-opus-4-7`. */
  model: string;
  /** Optional display label. */
  label?: string;
  /** Max output tokens (default 16k). */
  maxTokens?: number;
  /** Override API key (else uses ANTHROPIC_API_KEY env). */
  apiKey?: string;
}

export function anthropicRunner(options: AnthropicRunnerOptions): AgentRunner {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set; cannot run Anthropic agent');
  const client = new Anthropic({ apiKey });
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const id = `anthropic/${options.model}`;

  return {
    id,
    label: options.label ?? id,

    async run(taskDir: string, spec: TaskSpec): Promise<AgentRunResult> {
      const startedAt = new Date().toISOString();
      const startMs = Date.now();
      const { system, user } = composePrompt(taskDir, spec);

      const resp = await client.messages.create({
        model: options.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });

      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');

      const files = parseFencedOutputs(text);
      const { written, missing } = writeOutputs(taskDir, files, spec.outputFiles);

      const warnings: string[] = [];
      for (const f of missing) warnings.push(`agent did not emit expected output file: ${f}`);

      return {
        agentId: id,
        taskId: spec.id,
        startedAt,
        durationMs: Date.now() - startMs,
        tokens: {
          input: resp.usage.input_tokens,
          output: resp.usage.output_tokens,
        },
        outputs: written,
        rawResponse: text,
        warnings,
      };
    },
  };
}
