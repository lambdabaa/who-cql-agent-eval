/**
 * Agent-runner contract for v0.
 *
 * Each task lives on disk as a directory:
 *
 *   tasks/<task-id>/
 *     task.json         — TaskSpec (see ../agent_tasks/schema.ts)
 *     prompt.md         — natural-language brief for the agent
 *     inputs/           — supporting artifacts the agent may read
 *     outputs/          — agent writes the files listed in task.json.outputFiles
 *     groundtruth/      — reference values the grader compares against
 *                         (kept out of inputs/ so we don't leak them to the agent)
 *
 * An `AgentRunner` reads the task dir, calls the underlying model, and writes
 * files into outputs/. Runners do not grade — graders read outputs/ and the
 * task.json kind to produce a score.
 *
 * The contract is file-system-based on purpose: any agent that can read a
 * directory of inputs and emit a directory of outputs (API-driven, CLI tool,
 * or human) can plug in. Frontier APIs get thin adapters in this folder.
 */

import type { TaskSpec } from '../agent_tasks/schema.js';

export interface AgentRunner {
  /** Stable identifier persisted into baseline JSON (e.g. "anthropic/claude-opus-4-7"). */
  readonly id: string;
  /** Display label for reports. */
  readonly label: string;
  /**
   * Run one task end-to-end. Reads `<taskDir>/prompt.md` + `<taskDir>/inputs/`,
   * writes the files listed in `spec.outputFiles` under `<taskDir>/outputs/`.
   * Returns metadata about the call for the baseline report.
   */
  run(taskDir: string, spec: TaskSpec): Promise<AgentRunResult>;
}

export interface AgentRunResult {
  /** Agent id (matches runner.id). */
  agentId: string;
  /** Task id (matches spec.id). */
  taskId: string;
  /** ISO timestamp the call started. */
  startedAt: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Provider-reported token usage, when available. */
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Files the agent wrote, relative to outputs/. */
  outputs: string[];
  /** Raw text response from the model (for debugging/audit). */
  rawResponse?: string;
  /** Non-fatal warnings the runner observed (e.g. missing expected output file). */
  warnings: string[];
}
