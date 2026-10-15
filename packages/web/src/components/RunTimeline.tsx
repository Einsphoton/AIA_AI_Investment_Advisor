/**
 * Shared agent step timeline: progress bar + step list + error + streamed text.
 * Owner: Lead — rendered inside the right-bottom reasoning dock (and reused by
 * any future inline timeline). The dock header (title, status, buttons) lives in
 * `AgentActivityDock`, so this component stays layout-agnostic.
 */
import type { AgentStreamApi } from '../api/hooks';
import { ProgressBar } from './ui';
import { Markdown } from './markdown/Markdown';

/** 一次运行的终态。进度条必须按它收尾，不能一直停在「第 4/20 轮推理」。 */
export type RunTimelineState = 'running' | 'done' | 'error' | 'stopped';

export function runTimelineState(stream: AgentStreamApi): RunTimelineState {
  if (stream.running) return 'running';
  if (stream.finished?.status === 'error' || stream.error) return 'error';
  return stream.finished ? 'done' : 'stopped';
}

/**
 * 进度区文案。
 *
 * 服务端每进入一轮推理就推一条 `progress`（`第 N/M 轮推理`）。**收敛式结束**
 * （例如第 4 轮就得出结论）时最后一条就是 `4/20`，照搬会让「已完成」的运行
 * 看起来还在跑到 20 轮；用户正是看到这里对不上。所以按终态改写：
 *   · 运行中 → 服务端原文 + N/M
 *   · 已完成 → 满条 + 「共 N 轮推理」
 *   · 失败 / 中断 → 停在出错那一轮并换色
 */
export function runProgressView(
  stream: AgentStreamApi,
): { label: string; meta: string; value: number; tone: 'default' | 'ok' | 'error' | 'muted' } | null {
  const total = stream.progress?.total ?? 0;
  const done = stream.progress?.done ?? 0;
  if (total <= 0) return null;
  switch (runTimelineState(stream)) {
    case 'running':
      return { label: stream.progress?.label ?? '推理中', meta: `${done}/${total}`, value: done, tone: 'default' };
    case 'done':
      return { label: '分析完成', meta: `共 ${done} 轮推理`, value: total, tone: 'ok' };
    case 'error':
      return { label: '已失败', meta: `第 ${done}/${total} 轮中断`, value: done, tone: 'error' };
    default:
      return { label: '已中断', meta: `第 ${done}/${total} 轮`, value: done, tone: 'muted' };
  }
}

export function RunTimeline(props: { stream: AgentStreamApi; maxTextHeight?: number }) {
  const { stream } = props;
  const state = runTimelineState(stream);
  const progress = runProgressView(stream);
  const maxTextHeight = props.maxTextHeight ?? 200;
  const hasBody = progress !== null || stream.steps.length > 0 || !!stream.error || !!stream.text;
  if (!hasBody) return null;

  return (
    <div className="run-timeline">
      {progress && (
        <div className="mb-2">
          <div className="between tiny muted mb-1">
            <span className={`run-progress-label ${state}`}>{progress.label}</span>
            <span className="mono">{progress.meta}</span>
          </div>
          <ProgressBar value={progress.value} max={stream.progress?.total ?? 0} tone={progress.tone} />
        </div>
      )}

      {stream.steps.length > 0 && (
        <div className="step-list">
          {stream.steps.map((step) => (
            <div key={step.id} className="step">
              <span className={`step-dot ${step.status}`} />
              <div style={{ minWidth: 0 }}>
                <div className="step-label">
                  {step.label}
                  {step.toolName && <span className="mute mono tiny"> · {step.toolName}</span>}
                </div>
                {step.detail && <div className="step-detail">{step.detail.slice(0, 400)}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {stream.error && <div className="alert alert-error mt-2 small">{stream.error}</div>}

      {stream.text && (
        <div className="mt-2" style={{ maxHeight: maxTextHeight, overflowY: 'auto' }}>
          {/* 流式正文按 Markdown 渲染：未闭合的代码围栏也能容错显示。 */}
          <Markdown text={stream.text} variant="compact" metrics={false} />
        </div>
      )}
    </div>
  );
}
