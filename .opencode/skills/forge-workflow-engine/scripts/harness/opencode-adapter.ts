import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import type { AgentDescriptor, HarnessAdapter, ManifestTask, TaskResult, WorkflowState } from "../types.ts";

/**
 * OpenCode CLI harness adapter.
 *
 * Invokes `opencode run` with the agent (auto-discovered from the repo's
 * .opencode/agents/ directory) and the task prompt, captures stdout/stderr,
 * and returns a structured TaskResult.
 *
 * Expected CLI shape:
 *   opencode run [--model <model-id>] [--agent <agent-name>] "<prompt>"
 *
 * Set OPENCODE_BIN env var to override the opencode binary path.
 * Set OPENCODE_EXTRA_FLAGS env var to inject extra flags (e.g. "--no-stream").
 */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly name = "opencode";

  private readonly bin: string;
  private readonly extraFlags: string[];

  constructor() {
    this.bin = process.env["OPENCODE_BIN"] ?? "opencode";
    this.extraFlags = (process.env["OPENCODE_EXTRA_FLAGS"] ?? "").split(/\s+/).filter(Boolean);
  }

  async invoke(
    agent: AgentDescriptor,
    task: ManifestTask,
    _context: WorkflowState,
    repoRoot: string,
  ): Promise<TaskResult> {
    const start = Date.now();

    const modelFlag = agent.model ? ["--model", agent.model] : [];
    const agentFlag = agent.name ? ["--agent", agent.name] : [];

    const prompt = this.buildPrompt(agent, task);
    const args = [
      "run",
      ...modelFlag,
      ...agentFlag,
      ...this.extraFlags,
      prompt,
    ];

    const result = spawnSync(this.bin, args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const durationMs = Date.now() - start;

    if (result.status === 0) {
      const outputFiles = task.expectedOutputs.filter((path) =>
        existsSync(path.startsWith("/") ? path : `${repoRoot}/${path}`),
      );
      return { success: true, outputFiles, stdout, stderr, durationMs };
    }

    const failure = stderr || result.error?.message || `Exited with status ${result.status}`;
    return {
      success: false,
      outputFiles: [],
      stdout,
      stderr: failure,
      durationMs,
      errorMessage: failure,
    };
  }

  private buildPrompt(agent: AgentDescriptor, task: ManifestTask): string {
    const contextHints = task.expectedOutputs.length > 0
      ? `\n\nExpected output files: ${task.expectedOutputs.join(", ")}`
      : "";

    const validationHint = task.validationCommands.length > 0
      ? `\n\nValidation commands to run after completion: ${task.validationCommands.join("; ")}`
      : "";

    return [
      `Task: ${task.title}`,
      "",
      task.description,
      contextHints,
      validationHint,
    ].join("\n").trim();
  }
}

export function resolveAgentForTask(
  agents: AgentDescriptor[],
  ownerName: string | undefined,
): AgentDescriptor | undefined {
  if (!ownerName) return undefined;
  return agents.find((a) => a.name === ownerName);
}

export function loadAgentFile(agentPath: string): string {
  return existsSync(agentPath) ? readFileSync(agentPath, "utf8") : "";
}
