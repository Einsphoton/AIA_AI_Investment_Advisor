/**
 * Agent runtime — implements the frozen `AgentRuntime` interface
 * (packages/server/src/types/agent.ts).
 *
 * Owner: agent-engine. Loop in ./loop.ts, LLM client in ./llm.ts, tools in
 * ./tools.ts, prompt assembly in ./prompts.ts.
 */
import type { AgentDeps, AgentRunRequest, AgentRuntime } from '../types/agent.js';
import { setProviderKeys } from '../datasources/registry.js';
import { resolveLlmConfig, runAgent } from './loop.js';
import { toolDescriptors } from './tools.js';

export function createAgent(deps: AgentDeps): AgentRuntime {
  // Provider keys (env or injected) must reach the datasource chain.
  setProviderKeys(deps.providerKeys ?? {});

  return {
    isConfigured(): boolean {
      return resolveLlmConfig(deps).apiKey.trim().length > 0;
    },
    tools() {
      return toolDescriptors();
    },
    async run(request) {
      // `runAgent` is contractually non-throwing; this is belt-and-braces.
      try {
        return await runAgent(deps, request);
      } catch (error) {
        deps.logger.error('agent run failed before the loop started', error);
        throw error;
      }
    },
    /**
     * P1-3: continues a run from its stored transcript. The loop loads
     * `agent_run_messages` for `resumeRunId` and keeps going with the original
     * kind/target/allowWrites, so a capped or cancelled run is not lost.
     */
    async resume(runId, request) {
      const run = deps.getRepo().getRun(runId);
      if (!run) throw new Error(`运行记录 ${runId} 不存在，无法续跑`);
      const merged: AgentRunRequest = {
        kind: run.kind,
        title: run.title,
        goal: request?.goal ?? '',
        target: run.target,
        sink: request?.sink,
        sessionId: request?.sessionId,
        signal: request?.signal,
        maxTurns: request?.maxTurns,
        allowWrites: request?.allowWrites,
        resumeRunId: runId,
      };
      return runAgent(deps, merged);
    },
  };
}

/** Re-exported so route modules can implement `POST /api/settings/test-llm`. */
export { createLlmClient, NOT_CONFIGURED_MESSAGE } from './llm.js';
export { resolveLlmConfig } from './loop.js';
