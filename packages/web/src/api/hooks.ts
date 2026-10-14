/**
 * React data-fetching + agent-stream hooks. Owner: Lead.
 *
 * Both page teammates must use `useAgentStream` for AI buttons so that step
 * timelines, progress and error handling look identical everywhere.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, AgentRunKind, AgentStep, BudgetStatus } from '@aia/shared';
import { ApiError } from './client';
import { streamPost, type StreamHandle } from './sse';

/* ───────────────────────────────── useAsync ───────────────────────────────── */

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (updater: T | ((previous: T | null) => T | null)) => void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loaderRef
      .current()
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(toApiError(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const update = useCallback((updater: T | ((previous: T | null) => T | null)) => {
    setData((previous) => (typeof updater === 'function' ? (updater as (p: T | null) => T | null)(previous) : updater));
  }, []);

  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData: update };
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const err = error as Error;
  return new ApiError(0, 'CLIENT_ERROR', err?.message ?? '未知错误');
}

/* ─────────────────────────────── usePolling ───────────────────────────────── */

export function usePolling(callback: () => void, intervalMs: number | null): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => ref.current(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

/* ──────────────────────────── useAgentStream ──────────────────────────────── */

export interface RunProgress {
  done: number;
  total: number;
  label: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  args?: unknown;
  ok?: boolean;
  summary?: string;
}

export interface AgentStreamState {
  running: boolean;
  runId: string | null;
  kind: AgentRunKind | null;
  title: string;
  steps: AgentStep[];
  text: string;
  progress: RunProgress | null;
  /** Entities created/updated by the run — useful to trigger a list reload. */
  entities: { action: string; entity: string; id: string; label: string }[];
  /** Tool call/result pairs, in arrival order (chat renders these inline). */
  toolEvents: ToolEvent[];
  /** Latest budget snapshot pushed by a run (advice generation refreshes it). */
  budget: BudgetStatus | null;
  error: string | null;
  finished: { status: 'done' | 'error'; summary: string } | null;
}

const INITIAL: AgentStreamState = {
  running: false,
  runId: null,
  kind: null,
  title: '',
  steps: [],
  text: '',
  progress: null,
  entities: [],
  toolEvents: [],
  budget: null,
  error: null,
  finished: null,
};

export interface AgentStreamApi extends AgentStreamState {
  /** Starts an SSE run; resolves when the stream closes. */
  start: (path: string, body?: unknown) => Promise<AgentStreamState>;
  cancel: () => void;
  reset: () => void;
  /** Called after each entity event (e.g. to reload the current list). */
  onEntity?: (entity: { action: string; entity: string; id: string; label: string }) => void;
}

export function useAgentStream(onEntity?: AgentStreamApi['onEntity']): AgentStreamApi {
  const [state, setState] = useState<AgentStreamState>(INITIAL);
  const handleRef = useRef<StreamHandle | null>(null);
  const stateRef = useRef<AgentStreamState>(INITIAL);
  const onEntityRef = useRef(onEntity);
  onEntityRef.current = onEntity;

  const apply = useCallback((recipe: (previous: AgentStreamState) => AgentStreamState) => {
    setState((previous) => {
      const next = recipe(previous);
      stateRef.current = next;
      return next;
    });
  }, []);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'run-started':
          apply((p) => ({ ...p, running: true, runId: event.runId, kind: event.kind, title: event.title, error: null, finished: null }));
          break;
        case 'step':
          apply((p) => {
            const steps = p.steps.slice();
            const index = steps.findIndex((s) => s.id === event.step.id);
            if (index >= 0) steps[index] = event.step;
            else steps.push(event.step);
            return { ...p, steps };
          });
          break;
        case 'progress':
          apply((p) => ({ ...p, progress: { done: event.done, total: event.total, label: event.label } }));
          break;
        case 'text':
          apply((p) => ({ ...p, text: p.text + event.delta }));
          break;
        case 'entity':
          apply((p) => ({ ...p, entities: [...p.entities, { action: event.action, entity: event.entity, id: event.id, label: event.label }] }));
          onEntityRef.current?.({ action: event.action, entity: event.entity, id: event.id, label: event.label });
          break;
        case 'error':
          apply((p) => ({ ...p, error: event.message }));
          break;
        case 'tool-call':
          apply((p) => ({ ...p, toolEvents: [...p.toolEvents, { id: event.id, name: event.name, args: event.args }] }));
          break;
        case 'tool-result':
          apply((p) => {
            const toolEvents = p.toolEvents.slice();
            const index = toolEvents.findIndex((entry) => entry.id === event.id);
            const next = { id: event.id, name: event.name, ok: event.ok, summary: event.summary };
            if (index >= 0) toolEvents[index] = { ...toolEvents[index], ...next };
            else toolEvents.push(next);
            return { ...p, toolEvents };
          });
          break;
        case 'budget':
          apply((p) => ({ ...p, budget: event.budget }));
          break;
        case 'run-finished':
          apply((p) => ({
            ...p,
            running: false,
            finished: { status: event.status === 'error' ? 'error' : 'done', summary: event.summary },
            error: event.status === 'error' ? event.summary || event.error : p.error,
          }));
          break;
        case 'done':
          apply((p) => ({ ...p, running: false }));
          break;
        default:
          break;
      }
    },
    [apply],
  );

  const start = useCallback(
    (path: string, body?: unknown) => {
      apply(() => ({ ...INITIAL, running: true }));
      const handle = streamPost(path, body ?? {}, {
        onEvent: handleEvent,
        onClose: () => apply((p) => ({ ...p, running: false })),
      });
      handleRef.current = handle;
      return handle.done.then(() => stateRef.current);
    },
    [apply, handleEvent],
  );

  const cancel = useCallback(() => {
    handleRef.current?.cancel();
    apply((p) => ({ ...p, running: false }));
  }, [apply]);

  const reset = useCallback(() => apply(() => INITIAL), [apply]);

  return { ...state, start, cancel, reset, onEntity };
}

/* ───────────────────────────── formatters / misc ──────────────────────────── */

/** Debounced value, used by search boxes. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
