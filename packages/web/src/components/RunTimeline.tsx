/**
 * Shared agent step timeline: progress bar + step list + error + streamed text.
 * Owner: Lead — rendered inside the right-bottom reasoning dock (and reused by
 * any future inline timeline). The dock header (title, status, buttons) lives in
 * `AgentActivityDock`, so this component stays layout-agnostic.
 */
import type { AgentStreamApi } from '../api/hooks';
import { ProgressBar } from './ui';
import { Markdown } from './markdown/Markdown';

export function RunTimeline(props: { stream: AgentStreamApi; maxTextHeight?: number }) {
  const { stream } = props;
  const total = stream.progress?.total ?? 0;
  const done = stream.progress?.done ?? 0;
  const maxTextHeight = props.maxTextHeight ?? 200;
  const hasBody = total > 0 || stream.steps.length > 0 || !!stream.error || !!stream.text;
  if (!hasBody) return null;

  return (
    <div className="run-timeline">
      {total > 0 && (
        <div className="mb-2">
          <div className="between tiny muted mb-1">
            <span>{stream.progress?.label}</span>
            <span className="mono">
              {done}/{total}
            </span>
          </div>
          <ProgressBar value={done} max={total} />
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
