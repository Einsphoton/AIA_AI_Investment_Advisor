/**
 * Service locator.
 *
 * Kept deliberately tiny: modules import `getRepo()` / `getAgent()` /
 * `getScheduler()` instead of threading a context object through every
 * function. `index.ts` is the only place that wires implementations in.
 *
 * The scheduler registers itself *after* startup (it needs the settings that
 * only exist once the repository is open), which is why it has its own setter
 * rather than being a required member of `ServerServices`.
 */
import type { Repo } from './types/repo.js';
import type { AgentRuntime, Scheduler } from './types/agent.js';

export interface ServerServices {
  repo: Repo;
  agent: AgentRuntime;
}

let services: ServerServices | null = null;
let scheduler: Scheduler | null = null;

export function setServices(next: ServerServices): void {
  services = next;
}

export function getServices(): ServerServices {
  if (!services) {
    throw new Error('Server services are not initialised yet (call setServices first).');
  }
  return services;
}

export function getRepo(): Repo {
  return getServices().repo;
}

export function getAgent(): AgentRuntime {
  return getServices().agent;
}

/** Registered by `index.ts` right after the scheduler is created. */
export function setScheduler(next: Scheduler | null): void {
  scheduler = next;
}

/** The live scheduler, or null when the process has not started one yet. */
export function getScheduler(): Scheduler | null {
  return scheduler;
}

export type { Repo, AgentRuntime, Scheduler };
