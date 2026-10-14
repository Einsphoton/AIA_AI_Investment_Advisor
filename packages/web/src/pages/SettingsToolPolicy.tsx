/**
 * 工具策略区块（P1-1） — owner: web-ai-pages.
 *
 * 勾选 = 允许调用该工具；取消勾选 = 把工具名写入 `toolPolicy.deny`（模型会收到结构化拒绝）。
 * `requireWriteApproval` 打开后，写入类工具不再直接落库，而是进入待审批列表
 * （由 `PendingWritesBar` 在全局提示）。
 */
import { useState } from 'react';
import type { ToolPolicy, ToolRisk } from '@aia/shared';
import { api } from '../api/client';
import { useAsync } from '../api/hooks';
import { Badge, Button, Card, Checkbox, ErrorAlert, Loading } from '../components/ui';

interface ToolEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk?: ToolRisk;
  source?: string;
}

const RISK_LABEL: Record<ToolRisk, string> = { write: '写入', external: '外部', read: '只读' };
/** 危险程度降序展示：写入 → 外部 → 只读。 */
const RISK_ORDER: ToolRisk[] = ['write', 'external', 'read'];

function riskOf(tool: ToolEntry): ToolRisk {
  return tool.risk ?? 'read';
}

function riskTone(risk: ToolRisk): 'sell' | 'warn' | 'ok' {
  if (risk === 'write') return 'sell';
  if (risk === 'external') return 'warn';
  return 'ok';
}

export function ToolPolicyCard(props: { value: ToolPolicy; onChange: (next: ToolPolicy) => void }) {
  const tools = useAsync(() => api.agent.tools(), []);
  const [openTool, setOpenTool] = useState<string | null>(null);

  const value = props.value;
  const list = tools.data ?? [];
  const denied = new Set(value.deny ?? []);

  /** deny 统一去重 + 排序，便于与保存后的服务端值比较。 */
  function setDeny(names: string[]) {
    props.onChange({ ...value, deny: Array.from(new Set(names)).sort() });
  }

  function toggle(tool: ToolEntry, allowed: boolean) {
    const next = new Set(value.deny ?? []);
    if (allowed) next.delete(tool.name);
    else next.add(tool.name);
    setDeny([...next]);
  }

  const writeTools = list.filter((tool) => riskOf(tool) === 'write').map((tool) => tool.name);
  const grouped = RISK_ORDER.map((risk) => ({
    risk,
    tools: list.filter((tool) => riskOf(tool) === risk).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((group) => group.tools.length > 0);

  return (
    <Card
      title="工具策略"
      actions={
        <div className="toolbar">
          <Badge tone={denied.size > 0 ? 'warn' : 'ok'}>已禁用 {denied.size} 个</Badge>
          <Button size="sm" variant="ghost" disabled={list.length === 0} onClick={() => setDeny([])}>
            全部允许
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={list.length === 0}
            title="把所有 risk=write 的工具加入禁用列表"
            onClick={() => setDeny([...(value.deny ?? []), ...writeTools])}
          >
            只读 + 外部（禁用所有写入）
          </Button>
        </div>
      }
    >
      <div className="tiny mute mb-3">
        勾选 = 允许 Agent 调用；取消勾选 = 加入 deny 列表（模型会收到结构化的拒绝说明，而不是静默失败）。
        风险级别由服务端标注：<Badge tone="sell">写入</Badge> 会改动数据库，<Badge tone="warn">外部</Badge> 会访问网络，
        <Badge tone="ok">只读</Badge> 仅查询本地数据。
      </div>

      <ErrorAlert error={tools.error} onRetry={tools.reload} />
      {tools.loading && !tools.data && <Loading label="正在读取工具清单…" />}

      {!tools.loading && list.length === 0 && <div className="tiny mute">服务端未返回任何工具。</div>}

      {grouped.map((group) => (
        <div key={group.risk} className="mb-3">
          <div className="center gap-2 mb-2">
            <Badge tone={riskTone(group.risk)}>{RISK_LABEL[group.risk]}</Badge>
            <span className="tiny mute">{group.tools.length} 个工具</span>
          </div>

          <div className="flex" style={{ flexDirection: 'column', gap: 6 }}>
            {group.tools.map((tool) => (
              <div key={tool.name} className="panel">
                <div className="between wrap gap-2">
                  <Checkbox checked={!denied.has(tool.name)} onChange={(checked) => toggle(tool, checked)} label={<span className="mono small">{tool.name}</span>} />
                  <div className="center gap-2">
                    {tool.source && <span className="tiny mute">{tool.source}</span>}
                    <Badge tone={riskTone(riskOf(tool))}>{RISK_LABEL[riskOf(tool)]}</Badge>
                    <Button size="sm" variant="ghost" onClick={() => setOpenTool(openTool === tool.name ? null : tool.name)}>
                      {openTool === tool.name ? '收起' : '参数'}
                    </Button>
                  </div>
                </div>
                {tool.description && <div className="tiny muted mt-1">{tool.description}</div>}
                {openTool === tool.name && (
                  <pre className="tiny mono mt-1" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto', margin: 0, color: 'var(--text-dim)' }}>
                    {JSON.stringify(tool.parameters ?? {}, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="divider" />

      <Checkbox
        checked={Boolean(value.requireWriteApproval)}
        onChange={(checked) => props.onChange({ ...value, requireWriteApproval: checked })}
        label="写入操作需要人工审批（开启后 AI 的写操作会进入待审批列表，不直接落库）"
      />
      <div className="field-hint mt-1">
        审批条会出现在页面顶部；批准后立即执行该工具调用，驳回会把理由回传给模型。
      </div>
    </Card>
  );
}
