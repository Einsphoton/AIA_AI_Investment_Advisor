/**
 * Shared timeline panel for every AI button (资产分析 / 标的分析 / 投资建议 / Chat).
 * Owner: Lead — pages pass the state returned by `useAgentStream`.
 */
import type { AgentStreamApi } from '../api/hooks';
import { Badge, Button, ProgressBar } from './ui';

const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  error: '失败',
  pending: '等待',
};

export function RunPanel(props: {
  stream: AgentStreamApi;
  title?: string;
  /** Hide the raw model output (chat also renders it in the message list). */
  hideText?: boolean;
  className?: string;
}) {
  const { stream } = props;
  const visible = stream.running || stream.steps.length > 0 || stream.finished || stream.error;
  if (!visible) return null;

  const total = stream.progress?.total ?? 0;
  const done = stream.progress?.done ?? 0;

  return (
    <div className={`run-panel ${props.className ?? ''}`}>
      <div className="between mb-2">
        <div className="center gap-2">
          {stream.running ? <span className="step-dot running" /> : <span className={`step-dot ${stream.finished?.status === 'error' || stream.error ? 'error' : 'done'}`} />}
          <strong className="small">{props.title ?? stream.title ?? 'AI 运行'}</strong>
          {stream.running && <Badge tone="ai">运行中</Badge>}
          {!stream.running && stream.finished && (
            <Badge tone={stream.finished.status === 'error' ? 'warn' : 'ok'}>{STATUS_LABEL[stream.finished.status] ?? stream.finished.status}</Badge>
          )}
        </div>
        <div className="center gap-2">
          {stream.runId && <span className="mute tiny mono">run {stream.runId.slice(0, 8)}</span>}
          {stream.running && (
            <Button size="sm" variant="ghost" onClick={stream.cancel}>
              中断
            </Button>
          )}
          {!stream.running && (
            <Button size="sm" variant="ghost" onClick={stream.reset}>
              清除
            </Button>
          )}
        </div>
      </div>

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

      {!props.hideText && stream.text && (
        <pre
          className="mt-2 small"
          style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflowY: 'auto', margin: 0, color: 'var(--text-dim)' }}
        >
          {stream.text}
        </pre>
      )}

      {!stream.running && stream.finished?.summary && stream.steps.length === 0 && (
        <div className="tiny muted">{stream.finished.summary}</div>
      )}
    </div>
  );
}
