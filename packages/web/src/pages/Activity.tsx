/**
 * ActivityPage — 运行轨迹 / 写入审计 / 续跑（P1） — owner: web-ai-pages.
 *
 * 三块能力：
 *   · AI 运行记录（`GET /api/agent/runs`）— 过滤 kind、查看轨迹、断点续跑（SSE）
 *   · 运行轨迹弹窗（`GET /api/agent/runs/:id/trace`）— 概览 / 消息 / 步骤 / 审计 / 待审批
 *   · 写入审计（`GET /api/agent/audit`）
 *
 * 路由与导航由 Lead 在 App.tsx / Layout.tsx 中接入，本文件只导出 `ActivityPage`。
 */
import { useState, type CSSProperties } from 'react';
import type {
  AgentRunStatus,
  AgentRunSummary,
  AgentTrace,
  AgentStep,
  AuditEntry,
  PendingWrite,
  RunMessage,
  ToolRisk,
} from '@aia/shared';
import { api } from '../api/client';
import { useAgentActivity, useAgentRefresh } from '../api/agentActivity';
import { useAsync } from '../api/hooks';
import { fmtDateTime, fmtNum } from '../format';
import { Alert, Badge, Button, Card, Dropdown, Empty, ErrorAlert, KV, Loading, Modal } from '../components/ui';

/* ──────────────────────────────── shared bits ─────────────────────────────── */

const KIND_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部类型' },
  { value: 'asset-analysis', label: 'asset-analysis（资产分析）' },
  { value: 'watchlist-analysis', label: 'watchlist-analysis（标的分析）' },
  { value: 'ipo-analysis', label: 'ipo-analysis（打新分析）' },
  { value: 'option-advice', label: 'option-advice（期权卖权）' },
  { value: 'advice', label: 'advice（投资建议）' },
  { value: 'chat', label: 'chat（对话）' },
  { value: 'scheduled', label: 'scheduled（定时）' },
  { value: 'custom', label: 'custom（自定义）' },
];

const OUTCOME_LABEL: Record<AuditEntry['outcome'], string> = {
  executed: '已执行',
  denied: '已拒绝',
  deferred: '待审批',
  failed: '失败',
};

const ROLE_TONE: Record<RunMessage['role'], 'default' | 'ai' | 'manual' | 'ok' | 'warn'> = {
  system: 'default',
  user: 'manual',
  assistant: 'ai',
  tool: 'warn',
};

const RISK_LABEL: Record<ToolRisk, string> = { read: '只读', external: '外部', write: '写入' };

function riskTone(risk: ToolRisk): 'sell' | 'warn' | 'ok' {
  if (risk === 'write') return 'sell';
  if (risk === 'external') return 'warn';
  return 'ok';
}

function outcomeTone(outcome: AuditEntry['outcome']): 'ok' | 'warn' | 'ai' | 'sell' {
  if (outcome === 'executed') return 'ok';
  if (outcome === 'deferred') return 'ai';
  if (outcome === 'denied') return 'warn';
  return 'sell';
}

function RunStatusBadge({ status }: { status: AgentRunStatus }) {
  if (status === 'done') return <Badge tone="ok">已完成</Badge>;
  if (status === 'error') return <Badge tone="warn">失败</Badge>;
  return <Badge tone="ai">运行中</Badge>;
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** `AgentRunSummary` 目前未声明 token 字段；服务端若返回则展示，否则显示「—」。 */
function tokenText(run: AgentRunSummary): string {
  const extra = run as AgentRunSummary & { promptTokens?: number; completionTokens?: number };
  const prompt = typeof extra.promptTokens === 'number' ? extra.promptTokens : null;
  const completion = typeof extra.completionTokens === 'number' ? extra.completionTokens : null;
  if (prompt === null && completion === null) return '—';
  return fmtNum((prompt ?? 0) + (completion ?? 0), 0);
}

function entityText(entry: AuditEntry): string {
  if (!entry.entity) return '—';
  return entry.entityId ? `${entry.entity} · ${entry.entityId.slice(0, 8)}` : entry.entity;
}

/** OpenAI 形态 `[{id,type:'function',function:{name,arguments}}]`，解析失败时降级展示原文。 */
function parseToolCalls(raw: string | null): { name: string; args: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [{ name: 'tool_calls', args: raw.slice(0, 300) }];
    return parsed.map((entry) => {
      const call = entry as {
        name?: string;
        arguments?: unknown;
        args?: unknown;
        function?: { name?: string; arguments?: unknown };
      };
      const name = call.function?.name ?? call.name ?? 'unknown';
      const args = call.function?.arguments ?? call.arguments ?? call.args ?? {};
      return { name, args: typeof args === 'string' ? args : JSON.stringify(args) };
    });
  } catch {
    return [{ name: 'tool_calls（无法解析）', args: raw.slice(0, 300) }];
  }
}

function preStyle(maxHeight: number): CSSProperties {
  return {
    whiteSpace: 'pre-wrap',
    maxHeight,
    overflowY: 'auto',
    margin: 0,
    color: 'var(--text-dim)',
  };
}

/* ──────────────────────────────── audit table ─────────────────────────────── */

function AuditTable({ entries, loading }: { entries: AuditEntry[]; loading?: boolean }) {
  if (loading && entries.length === 0) return <Loading label="正在读取审计记录…" />;
  if (entries.length === 0) return <Empty title="暂无审计记录" hint="AI 调用工具后这里会记录风险、结果与实体。" />;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>工具</th>
            <th>风险</th>
            <th>结果</th>
            <th>实体</th>
            <th>参数摘要</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td className="tiny nowrap">{fmtDateTime(entry.at)}</td>
              <td>
                <div className="mono tiny">{entry.tool}</div>
                {entry.summary && <div className="tiny mute">{truncate(entry.summary, 60)}</div>}
              </td>
              <td>
                <Badge tone={riskTone(entry.risk)}>{RISK_LABEL[entry.risk] ?? entry.risk}</Badge>
              </td>
              <td>
                <Badge tone={outcomeTone(entry.outcome)}>{OUTCOME_LABEL[entry.outcome] ?? entry.outcome}</Badge>
              </td>
              <td className="tiny mute">{entityText(entry)}</td>
              <td className="tiny mono mute" title={entry.args}>
                {truncate(entry.args, 90) || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────────── trace sections ───────────────────────────── */

function MessageList({ messages }: { messages: RunMessage[] }) {
  if (messages.length === 0) return <div className="tiny mute">该运行没有持久化的消息记录。</div>;
  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 8 }}>
      {messages.map((message) => {
        const calls = parseToolCalls(message.toolCalls);
        const isTool = message.role === 'tool';
        return (
          <div key={message.id} className="panel">
            <div className="between wrap gap-2">
              <div className="center gap-2">
                <Badge tone={ROLE_TONE[message.role] ?? 'default'}>{message.role}</Badge>
                <span className="tiny mute">
                  #{message.index}
                  {message.name ? ` · ${message.name}` : ''}
                </span>
              </div>
              <span className="tiny mute nowrap">{fmtDateTime(message.createdAt)}</span>
            </div>

            {message.content ? (
              <div className={isTool ? 'mono tiny mt-1' : 'mt-1 small'} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {truncate(message.content, isTool ? 800 : 1600)}
              </div>
            ) : (
              <div className="tiny mute mt-1">（无文本内容）</div>
            )}

            {calls.length > 0 && (
              <div className="mt-2">
                <div className="tiny mute mb-1">工具调用（{calls.length}）</div>
                {calls.map((call, index) => (
                  <div key={`${message.id}-${index}`} className="panel mb-1">
                    <div className="tiny strong mono">{call.name}</div>
                    <pre className="tiny mono" style={preStyle(120)}>
                      {truncate(call.args, 400)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepTimeline({ steps }: { steps: AgentStep[] }) {
  if (steps.length === 0) return <div className="tiny mute">该运行没有记录步骤。</div>;
  return (
    <div className="step-list">
      {steps.map((step) => (
        <div key={step.id} className="step">
          <span className={`step-dot ${step.status}`} />
          <div style={{ minWidth: 0 }}>
            <div className="step-label">
              {step.label}
              {step.toolName && <span className="mute mono tiny"> · {step.toolName}</span>}
            </div>
            {step.detail && <div className="step-detail">{truncate(step.detail, 400)}</div>}
            {step.toolArgs && (
              <pre className="tiny mono" style={preStyle(140)}>
                {truncate(step.toolArgs, 400)}
              </pre>
            )}
            {step.toolResult && <div className="step-detail">结果：{truncate(step.toolResult, 400)}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function TracePendingList({ items }: { items: PendingWrite[] }) {
  if (items.length === 0) return <div className="tiny mute">该运行没有待审批的写入。</div>;
  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 8 }}>
      {items.map((item) => (
        <div key={item.id} className="panel">
          <div className="between wrap gap-2">
            <div className="center gap-2">
              <span className="mono small strong">{item.tool}</span>
              <Badge tone={riskTone(item.risk)}>{RISK_LABEL[item.risk] ?? item.risk}</Badge>
              <Badge tone={item.status === 'pending' ? 'warn' : item.status === 'failed' ? 'sell' : 'ok'}>{item.status}</Badge>
            </div>
            <span className="tiny mute nowrap">{fmtDateTime(item.createdAt)}</span>
          </div>
          {item.summary && <div className="tiny muted mt-1">{item.summary}</div>}
          <pre className="tiny mono mt-1" style={preStyle(120)}>
            {truncate(item.args, 400)}
          </pre>
          {item.result && <div className="tiny mute mt-1">结果：{truncate(item.result, 200)}</div>}
        </div>
      ))}
    </div>
  );
}

function TraceView({ trace }: { trace: AgentTrace }) {
  const run = trace.run;
  const messages = [...trace.messages].sort((a, b) => a.index - b.index);
  const steps = [...trace.steps].sort((a, b) => a.index - b.index);
  const tokens = fmtNum(run.promptTokens ?? 0, 0) + ' + ' + fmtNum(run.completionTokens ?? 0, 0);

  return (
    <>
      <section className="mb-3">
        <div className="small strong mb-2">概览</div>
        <KV
          items={[
            ['状态', <RunStatusBadge status={run.status} />],
            ['类型', <span className="mono tiny">{run.kind}</span>],
            ['目标', run.target ?? '—'],
            ['轮次', fmtNum(run.turns, 0)],
            ['token', `${tokens} = ${fmtNum((run.promptTokens ?? 0) + (run.completionTokens ?? 0), 0)}`],
            ['开始', fmtDateTime(run.startedAt)],
            ['结束', run.finishedAt ? fmtDateTime(run.finishedAt) : '运行中'],
          ]}
        />
        {run.summary && <div className="tiny muted mt-2">{run.summary}</div>}
        {run.error && (
          <div className="mt-2">
            <Alert tone="error">{run.error}</Alert>
          </div>
        )}
      </section>

      <div className="divider" />

      <section className="mb-3">
        <div className="small strong mb-2">消息轨迹（{messages.length}）</div>
        <MessageList messages={messages} />
      </section>

      <div className="divider" />

      <section className="mb-3">
        <div className="small strong mb-2">步骤时间线（{steps.length}）</div>
        <StepTimeline steps={steps} />
      </section>

      <div className="divider" />

      <section className="mb-3">
        <div className="small strong mb-2">审计（{trace.audit.length}）</div>
        <AuditTable entries={trace.audit} />
      </section>

      <div className="divider" />

      <section>
        <div className="small strong mb-2">待审批（{trace.pendingWrites.length}）</div>
        <TracePendingList items={trace.pendingWrites} />
      </section>
    </>
  );
}

function TraceModal({ run, onClose }: { run: AgentRunSummary; onClose: () => void }) {
  const trace = useAsync(() => api.agent.trace(run.id), [run.id]);
  return (
    <Modal open size="lg" title={`运行轨迹 · ${run.title || run.id.slice(0, 8)}`} onClose={onClose}>
      <div className="tiny mute mb-2 mono">run {run.id}</div>
      {trace.loading && !trace.data && <Loading label="正在读取运行轨迹…" />}
      <ErrorAlert error={trace.error} onRetry={trace.reload} />
      {trace.data && <TraceView trace={trace.data} />}
    </Modal>
  );
}

/* ─────────────────────────────────── page ─────────────────────────────────── */

export function ActivityPage() {
  const [kind, setKind] = useState('');
  const runs = useAsync(() => api.agent.runs(50, kind || undefined), [kind]);
  const audit = useAsync(() => api.agent.audit({ limit: 50 }), []);
  const [traceRun, setTraceRun] = useState<AgentRunSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 续跑的推理过程同样显示在右下角全局面板里；运行结束后刷新运行列表与审计。
  const { run: startRun, running } = useAgentActivity();

  const items = runs.data ?? [];

  function refreshAll() {
    runs.reload();
    audit.reload();
  }

  useAgentRefresh(() => {
    setBusyId(null);
    refreshAll();
  });

  function resume(run: AgentRunSummary) {
    setBusyId(run.id);
    startRun({ path: `/agent/runs/${encodeURIComponent(run.id)}/resume`, title: `续跑 · ${run.title || run.id.slice(0, 8)}` });
  }

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 14 }}>
      <Card
        title="AI 运行记录"
        actions={
          <div className="toolbar">
            <Dropdown
              size="sm"
              value={kind}
              items={KIND_OPTIONS}
              ariaLabel="运行类型筛选"
              onChange={setKind}
            />
            <Button size="sm" loading={runs.loading} onClick={refreshAll}>
              刷新
            </Button>
          </div>
        }
      >
        <div className="tiny mute mb-3">
          每次 AI 运行（资产分析 / 标的分析 / 建议 / 对话 / 定时）都会记录在此。可查看完整轨迹（消息 · 步骤 · 审计 · 待审批），
          未完成的运行可以从中断处「续跑」。
        </div>

        <ErrorAlert error={runs.error} onRetry={runs.reload} />

        {runs.loading && !runs.data && <Loading label="正在加载运行记录…" />}

        {!runs.loading && items.length === 0 && (
          <Empty title="暂无运行记录" hint="运行一次 AI 分析后即可在这里回放轨迹。" />
        )}

        {items.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>标题</th>
                  <th>类型</th>
                  <th>状态</th>
                  <th className="num">轮次</th>
                  <th className="num">步数</th>
                  <th className="num">token</th>
                  <th>开始时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <div className="strong">{run.title || '（无标题）'}</div>
                      <div className="tiny mute mono">{run.id.slice(0, 8)}</div>
                      {run.summary && <div className="tiny mute">{truncate(run.summary, 70)}</div>}
                    </td>
                    <td className="tiny mono">{run.kind}</td>
                    <td>
                      <RunStatusBadge status={run.status} />
                    </td>
                    <td className="num">{fmtNum(run.turns, 0)}</td>
                    <td className="num">{fmtNum(run.stepCount, 0)}</td>
                    <td className="num">{tokenText(run)}</td>
                    <td className="tiny nowrap">{fmtDateTime(run.startedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" variant="ghost" onClick={() => setTraceRun(run)}>
                          查看轨迹
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={run.status === 'done' || running}
                          loading={busyId === run.id}
                          title={
                            run.status === 'done'
                              ? '已完成的运行无需续跑'
                              : running
                                ? '已有 AI 流水线正在运行（见右下角面板）'
                                : '从中断处继续执行'
                          }
                          onClick={() => resume(run)}
                        >
                          续跑
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="写入审计"
        actions={
          <Button size="sm" variant="ghost" loading={audit.loading} onClick={() => audit.reload()}>
            刷新
          </Button>
        }
      >
        <div className="tiny mute mb-3">
          工具调用的风险级别与结果（已执行 / 已拒绝 / 待审批 / 失败）。写入与外部调用是审计重点。
        </div>
        <ErrorAlert error={audit.error} onRetry={audit.reload} />
        <AuditTable entries={audit.data ?? []} loading={audit.loading && !audit.data} />
      </Card>

      {traceRun && <TraceModal run={traceRun} onClose={() => setTraceRun(null)} />}
    </div>
  );
}
