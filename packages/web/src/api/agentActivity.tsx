/**
 * Global Agent-activity store. Owner: Lead.
 *
 * Every AI entry point (Dashboard 一键分析 / 资产分析 / 标的分析 / 投资建议 /
 * 活动页续跑) runs through this provider, which owns the single in-flight SSE
 * stream. It sits **above the router**, so switching pages no longer unmounts a
 * run: the right-bottom dock keeps streaming steps, inference metrics and the
 * final summary while the user browses elsewhere.
 *
 * Two contexts on purpose:
 *   · `AgentStreamContext` — the live stream state; changes on every token, so
 *     only the dock subscribes to it;
 *   · `AgentActivityContext` — actions + coarse status (running / title / …);
 *     memoized so pages do not re-render for every streamed character.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BudgetStatus } from '@aia/shared';
import { useAgentStream, type AgentEntityEvent, type AgentStreamApi } from './hooks';
import { useToast } from '../components/ui';

export type { AgentEntityEvent } from './hooks';
export type AgentEntityHandler = (event: AgentEntityEvent) => void;

export interface AgentRunRequest {
  /** SSE endpoint below `/api`, e.g. `/agent/run-now`. */
  path: string;
  /** User-facing name of the run: dock header + completion toast. */
  title: string;
  body?: unknown;
}

export interface AgentActivityControl {
  /** Starts a run; shows a toast instead when one is already in flight. */
  run: (request: AgentRunRequest) => void;
  running: boolean;
  /** Title of the current/last run. */
  title: string;
  /** Epoch ms when the current run started (dock elapsed timer). */
  startedAt: number | null;
  /** Latest budget snapshot pushed by a run (advice generation refreshes it). */
  budget: BudgetStatus | null;
  /** Increments once per finished stream — pages reload their lists on change. */
  finishedNonce: number;
  /** Subscribes to `entity` events (SSE writes); returns the unsubscribe fn. */
  subscribeEntities: (handler: AgentEntityHandler) => () => void;
  /** Dock collapse state, persisted per browser. */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  /** True after the user cleared the dock; a new run un-dismisses it. */
  dismissed: boolean;
  dismiss: () => void;
}

const AgentStreamContext = createContext<AgentStreamApi | null>(null);
const AgentActivityContext = createContext<AgentActivityControl | null>(null);

const COLLAPSE_STORAGE_KEY = 'aia.agent-dock.collapsed';

function readCollapsed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function AgentActivityProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [finishedNonce, setFinishedNonce] = useState(0);
  const [collapsed, setCollapsedState] = useState(readCollapsed);
  const [dismissed, setDismissed] = useState(false);

  /** Page-level `entity` subscribers (kept in a ref: no re-render per event). */
  const handlers = useRef(new Set<AgentEntityHandler>());

  const stream = useAgentStream(
    useCallback((event: AgentEntityEvent) => {
      for (const handler of [...handlers.current]) {
        try {
          handler(event);
        } catch {
          // A page callback must never break the running stream.
        }
      }
    }, []),
  );
  const streamRef = useRef(stream);
  streamRef.current = stream;

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // Private mode / storage disabled: keep the in-memory value only.
    }
  }, []);

  const subscribeEntities = useCallback((handler: AgentEntityHandler) => {
    handlers.current.add(handler);
    return () => {
      handlers.current.delete(handler);
    };
  }, []);

  const run = useCallback(
    (request: AgentRunRequest) => {
      // The server also rejects concurrent pipelines; stopping here avoids
      // wiping the currently running timeline out of the dock.
      if (streamRef.current.running) {
        toast.info('已有 AI 流水线正在运行', '可查看右下角的推理面板，或先中断当前运行。');
        return;
      }
      setTitle(request.title);
      setStartedAt(Date.now());
      setDismissed(false);
      setCollapsed(false);
      void streamRef.current.start(request.path, request.body);
    },
    [setCollapsed, toast],
  );

  // One toast per stream: a full pipeline emits several `run-finished` events.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !stream.running) {
      const message = stream.finished?.summary || stream.error || '';
      const label = title || 'AI 分析';
      if (stream.finished?.status === 'error' || stream.error) toast.error(`${label}失败`, message);
      else if (stream.finished) toast.success(`${label}完成`, message);
      setFinishedNonce((value) => value + 1);
    }
    wasRunning.current = stream.running;
    // `finished`/`error` are read at the transition only — not part of the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.running, toast, title]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    streamRef.current.reset();
  }, []);

  const control = useMemo<AgentActivityControl>(
    () => ({
      run,
      running: stream.running,
      title,
      startedAt,
      budget: stream.budget,
      finishedNonce,
      subscribeEntities,
      collapsed,
      setCollapsed,
      dismissed,
      dismiss,
    }),
    [
      run,
      stream.running,
      stream.budget,
      title,
      startedAt,
      finishedNonce,
      subscribeEntities,
      collapsed,
      setCollapsed,
      dismissed,
      dismiss,
    ],
  );

  return (
    <AgentActivityContext.Provider value={control}>
      <AgentStreamContext.Provider value={stream}>{children}</AgentStreamContext.Provider>
    </AgentActivityContext.Provider>
  );
}

export function useAgentActivity(): AgentActivityControl {
  const value = useContext(AgentActivityContext);
  if (!value) throw new Error('useAgentActivity 必须在 <AgentActivityProvider> 内使用');
  return value;
}

/** Live stream state; only the dock needs it (re-renders on every token). */
export function useAgentStreamState(): AgentStreamApi {
  const value = useContext(AgentStreamContext);
  if (!value) throw new Error('useAgentStreamState 必须在 <AgentActivityProvider> 内使用');
  return value;
}

/**
 * Reloads the calling page whenever the agent writes an entity or a run ends.
 *
 * Replaces the old per-page `useAgentStream(() => reload())` wiring: the stream
 * lives in the provider now, so pages only register a refresh callback.
 */
export function useAgentRefresh(reload: () => void): void {
  const { subscribeEntities, finishedNonce } = useAgentActivity();
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => subscribeEntities(() => reloadRef.current()), [subscribeEntities]);
  useEffect(() => {
    if (finishedNonce > 0) reloadRef.current();
  }, [finishedNonce]);
}
