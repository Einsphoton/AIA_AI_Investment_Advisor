/**
 * Right-bottom reasoning dock. Owner: Lead.
 *
 * Rendered once by `App`, **outside the router**, so the agent's reasoning keeps
 * running and stays visible while the user switches pages. Collapsible to a
 * one-line pill (state persisted per browser) so it never eats the page.
 *
 * Telemetry shown while the model thinks: 首字延迟 (TTFT), 生成速度 (tok/s),
 * Token 用量, KV Cache 命中率, plus the write summary and step timeline.
 */
import { useEffect, useState } from 'react';
import { useAgentActivity, useAgentStreamState } from '../api/agentActivity';
import {
  fmtCacheHitRate,
  fmtMilliseconds,
  fmtSpeed,
  fmtTokens,
  summarizeEntities,
  summarizeMetrics,
} from '../api/agentMetrics';
import { RunTimeline, runTimelineState } from './RunTimeline';
import { Badge, Button } from './ui';

/** 推理面板的状态：中断（没有 run-finished）不能算「已完成」。 */
type DockStatus = 'running' | 'done' | 'error' | 'stopped';

const STATUS_TEXT: Record<DockStatus, string> = { running: '推理中', done: '已完成', error: '失败', stopped: '已中断' };

export function AgentActivityDock() {
  const stream = useAgentStreamState();
  const { title, running, startedAt, collapsed, setCollapsed, dismissed } = useAgentActivity();
  const [now, setNow] = useState(() => Date.now());
  const [rootEl, setRootEl] = useState<HTMLElement | null>(null);

  // Live elapsed timer, only while a run is in flight.
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  // Toasts live in the same corner: reserve the dock's height above them so the
  // completion toast never covers the reasoning panel.
  useEffect(() => {
    const root = document.documentElement;
    if (!rootEl) {
      root.style.removeProperty('--dock-reserve');
      return;
    }
    const update = (): void => {
      root.style.setProperty('--dock-reserve', `${Math.round(rootEl.getBoundingClientRect().height) + 30}px`);
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(rootEl);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--dock-reserve');
    };
  }, [rootEl]);

  // Nothing to show until a run has been started from anywhere in the app.
  const visible = !dismissed && (running || stream.steps.length > 0 || !!stream.finished || !!stream.error);
  if (!visible) return null;

  // 与进度条共用同一套终态判断：中断的运行不能被显示成「已完成」。
  const status: DockStatus = runTimelineState(stream);
  const label = title || stream.title || 'AI 推理过程';
  const totals = summarizeMetrics(stream.metricsEvents);
  const latest = stream.metrics;
  const elapsed = running && startedAt !== null ? now - startedAt : null;
  const entitySummary = summarizeEntities(stream.entities).join(' · ');

  if (collapsed) {
    return (
      <button
        type="button"
        className="agent-dock-pill"
        ref={setRootEl}
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
        aria-label={`展开 AI 推理面板（${label} · ${STATUS_TEXT[status]}）`}
      >
        <span className={`step-dot ${status}`} />
        <span className="agent-dock-pill-title truncate">{label}</span>
        <span className="agent-dock-pill-meta mono tiny">
          {STATUS_TEXT[status]}
          {elapsed !== null ? ` ${fmtMilliseconds(elapsed)}` : ''}
        </span>
        <span className="agent-dock-caret" aria-hidden="true">
          ▴
        </span>
      </button>
    );
  }

  return (
    <section className="agent-dock" aria-label="AI 推理过程" data-status={status} ref={setRootEl}>
      <header className="agent-dock-head">
        <span className={`step-dot ${status}`} />
        <strong className="agent-dock-title truncate" title={label}>
          {label}
        </strong>
        <Badge tone={status === 'error' ? 'warn' : status === 'done' ? 'ok' : status === 'running' ? 'ai' : 'default'}>
          {STATUS_TEXT[status]}
        </Badge>
        <span className="agent-dock-actions">
          {running ? (
            <Button size="sm" variant="ghost" onClick={stream.cancel} title="中断本次运行">
              中断
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(true)} title="收起为右下角小条（再次点击右下角小条可展开）">
              收起
            </Button>
          )}
        </span>
      </header>

      <div className="agent-dock-meta tiny mute">
        {/* 结束后不能再写「第 4 轮推理」（读起来像还在跑），改成总轮次。 */}
        {latest && <span>{running ? `第 ${latest.turn} 轮推理` : `共 ${latest.turn} 轮推理`}</span>}
        <span>{totals.requests} 次 LLM 请求</span>
        {elapsed !== null ? (
          <span>已运行 {fmtMilliseconds(elapsed)}</span>
        ) : (
          totals.lastLatencyMs !== null && <span>最近耗时 {fmtMilliseconds(totals.lastLatencyMs)}</span>
        )}
        {totals.model && (
          <span className="mono truncate" title={totals.model}>
            {totals.model}
          </span>
        )}
      </div>

      <div className="agent-dock-metrics">
        <div className="agent-metric">
          <div className="agent-metric-label">首字延迟</div>
          <div className="agent-metric-value mono">{fmtMilliseconds(latest?.ttftMs ?? totals.bestTtftMs)}</div>
          <div className="agent-metric-sub">TTFT · 最快 {fmtMilliseconds(totals.bestTtftMs)}</div>
        </div>
        <div className="agent-metric">
          <div className="agent-metric-label">生成速度</div>
          <div className="agent-metric-value mono">{fmtSpeed(totals.tokensPerSecond)}</div>
          <div className="agent-metric-sub">输出 tokens / 秒</div>
        </div>
        <div className="agent-metric">
          <div className="agent-metric-label">Token 用量</div>
          <div className="agent-metric-value mono">{fmtTokens(totals.totalTokens)}</div>
          <div className="agent-metric-sub">
            入 {fmtTokens(totals.promptTokens)} · 出 {fmtTokens(totals.completionTokens)}
          </div>
        </div>
        <div className="agent-metric">
          <div className="agent-metric-label">KV Cache 命中率</div>
          <div className="agent-metric-value mono">{fmtCacheHitRate(totals.cacheHitRate)}</div>
          <div className="agent-metric-sub">
            {totals.promptTokens > 0 ? `命中 ${fmtTokens(totals.cachedTokens)} / ${fmtTokens(totals.promptTokens)}` : '暂无缓存数据'}
          </div>
        </div>
      </div>

      {entitySummary && <div className="agent-dock-writes tiny mute">写入：{entitySummary}</div>}

      <div className="agent-dock-body">
        <RunTimeline stream={stream} maxTextHeight={180} />
      </div>
    </section>
  );
}
