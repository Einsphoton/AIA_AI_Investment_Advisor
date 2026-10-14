/**
 * MCP 服务器配置区块（P1-2） — owner: web-ai-pages.
 *
 * 列表展示已配置的 MCP server（连接状态来自 `GET /api/mcp/servers`），支持启用/停用、
 * 单独测试（`POST /api/mcp/servers/:id/test`）、删除与「重新加载全部」（`POST /api/mcp/reload`）。
 * 所有编辑只改本地草稿，由 Settings 页的「保存设置」统一提交（整体替换 `mcpServers`）。
 */
import { useState } from 'react';
import type { McpServerConfig } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync } from '../api/hooks';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Segmented,
  Textarea,
  useToast,
} from '../components/ui';

interface McpStatus {
  id: string;
  name: string;
  transport: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  tools: string[];
  error: string | null;
}

interface TestResult {
  ok: boolean;
  toolCount: number;
  tools: string[];
  error: string | null;
}

interface FormState {
  id: string;
  name: string;
  transport: McpServerConfig['transport'];
  command: string;
  args: string;
  env: string;
  url: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = { id: '', name: '', transport: 'stdio', command: '', args: '', env: '', url: '', enabled: true };

function parseArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 每行 `KEY=VALUE`；忽略空行、`#` 注释与缺少 `=` 的行。 */
function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const index = text.indexOf('=');
    if (index <= 0) continue;
    const key = text.slice(0, index).trim();
    if (key) out[key] = text.slice(index + 1).trim();
  }
  return out;
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function validate(form: FormState, existing: McpServerConfig[]): string | null {
  const id = form.id.trim();
  if (!id) return 'id 不能为空';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return 'id 只能包含字母、数字、下划线和中划线';
  if (existing.some((server) => server.id === id)) return `id「${id}」已存在，请换一个`;
  if (!form.name.trim()) return '名称不能为空';
  if (form.transport === 'stdio' && !form.command.trim()) return 'stdio 传输必须填写 command';
  if (form.transport === 'http' && !form.url.trim()) return 'http 传输必须填写 url';
  return null;
}

function targetOf(server: McpServerConfig): string {
  return server.transport === 'http' ? server.url || '—' : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') || '—';
}

export function McpServersCard(props: { value: McpServerConfig[]; onChange: (next: McpServerConfig[]) => void }) {
  const toast = useToast();
  const status = useAsync(() => api.mcp.servers(), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [deleteTarget, setDeleteTarget] = useState<McpServerConfig | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadResult, setReloadResult] = useState<{ reloaded: number; failed: number } | null>(null);

  const servers = props.value ?? [];

  function patch(changes: Partial<FormState>) {
    setForm((previous) => ({ ...previous, ...changes }));
  }

  function submit() {
    const error = validate(form, servers);
    if (error) {
      setFormError(error);
      return;
    }
    const server: McpServerConfig = {
      id: form.id.trim(),
      name: form.name.trim(),
      transport: form.transport,
      command: form.transport === 'stdio' ? form.command.trim() : '',
      args: form.transport === 'stdio' ? parseArgs(form.args) : [],
      env: form.transport === 'stdio' ? parseEnv(form.env) : {},
      url: form.transport === 'http' ? form.url.trim() : '',
      enabled: form.enabled,
    };
    props.onChange([...servers, server]);
    setForm(EMPTY_FORM);
    setFormError(null);
    setAdding(false);
    toast.success('已加入草稿', '点击「保存设置」后生效');
  }

  function remove(server: McpServerConfig) {
    props.onChange(servers.filter((entry) => entry.id !== server.id));
    setDeleteTarget(null);
    toast.success('已从草稿移除', '点击「保存设置」后生效');
  }

  function toggleEnabled(server: McpServerConfig, enabled: boolean) {
    props.onChange(servers.map((entry) => (entry.id === server.id ? { ...entry, enabled } : entry)));
  }

  async function test(server: McpServerConfig) {
    setTestingId(server.id);
    try {
      const result = await api.mcp.test(server.id);
      setTests((previous) => ({ ...previous, [server.id]: result }));
      if (result.ok) toast.success(`连接成功：${server.name}`, `${result.toolCount} 个工具`);
      else toast.warn(`连接失败：${server.name}`, result.error ?? '未知错误');
    } catch (error) {
      const message = toApiError(error).message;
      setTests((previous) => ({ ...previous, [server.id]: { ok: false, toolCount: 0, tools: [], error: message } }));
      toast.error('测试失败', message);
    } finally {
      setTestingId(null);
    }
  }

  async function reloadAll() {
    setReloading(true);
    try {
      const result = await api.mcp.reload();
      setReloadResult(result);
      status.reload();
      if (result.failed > 0) toast.warn('重新加载完成', `成功 ${result.reloaded} 个，失败 ${result.failed} 个`);
      else toast.success('重新加载完成', `成功 ${result.reloaded} 个`);
    } catch (error) {
      toast.error('重新加载失败', toApiError(error).message);
    } finally {
      setReloading(false);
    }
  }

  return (
    <Card
      title={
        <span className="center gap-2">
          MCP 服务器
          <Badge tone={servers.length > 0 ? 'ok' : 'default'}>{servers.length} 个</Badge>
        </span>
      }
      actions={
        <div className="toolbar">
          <Button size="sm" variant="ghost" loading={reloading} onClick={() => void reloadAll()}>
            重新加载全部
          </Button>
          <Button
            size="sm"
            variant={adding ? 'ghost' : 'primary'}
            onClick={() => {
              setAdding((previous) => !previous);
              setFormError(null);
            }}
          >
            {adding ? '取消添加' : '添加服务器'}
          </Button>
        </div>
      }
    >
      <div className="tiny mute mb-3">
        MCP（Model Context Protocol）服务器提供的工具会以 <span className="mono">mcp__&lt;server&gt;__&lt;tool&gt;</span> 出现在 AI
        工具列表中（风险级别：external）。
      </div>

      <ErrorAlert error={status.error} onRetry={status.reload} />
      {status.loading && !status.data && <Loading label="正在读取 MCP 状态…" />}
      {reloadResult && (
        <div className="mb-2">
          <Badge tone={reloadResult.failed > 0 ? 'warn' : 'ok'}>
            重载结果：成功 {reloadResult.reloaded} · 失败 {reloadResult.failed}
          </Badge>
        </div>
      )}

      {servers.length === 0 && !adding && (
        <div className="tiny mute mb-3">尚未配置任何 MCP 服务器；点击「添加服务器」接入 stdio 或 http 传输的外部工具。</div>
      )}

      <div className="flex" style={{ flexDirection: 'column', gap: 8 }}>
        {servers.map((server) => {
          const live: McpStatus | undefined = status.data?.find((entry) => entry.id === server.id);
          const tested = tests[server.id];
          const connected = live?.connected ?? false;
          const toolCount = live?.toolCount ?? 0;
          const error = live?.error ?? null;
          return (
            <div key={server.id} className="panel">
              <div className="between wrap gap-2">
                <div className="center gap-2 wrap">
                  <span className="small strong">{server.name}</span>
                  <span className="tiny mute mono">{server.id}</span>
                  <Badge tone={server.transport === 'http' ? 'ai' : 'manual'}>{server.transport}</Badge>
                  {!server.enabled && <Badge tone="default">已停用</Badge>}
                  {server.enabled && (connected ? <Badge tone="ok">已连接 · {toolCount} 工具</Badge> : <Badge tone="warn">未连接</Badge>)}
                </div>
                <div className="row-actions">
                  <Checkbox
                    checked={server.enabled}
                    onChange={(checked) => toggleEnabled(server, checked)}
                    label={<span className="tiny">启用</span>}
                  />
                  <Button size="sm" variant="ghost" loading={testingId === server.id} onClick={() => void test(server)}>
                    测试
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setDeleteTarget(server)}>
                    删除
                  </Button>
                </div>
              </div>

              <div className="tiny mono mt-1" style={{ wordBreak: 'break-all' }}>
                {server.transport === 'http' ? 'url: ' : 'cmd: '}
                {targetOf(server)}
              </div>
              {server.transport === 'stdio' && Object.keys(server.env ?? {}).length > 0 && (
                <div className="tiny mute mono mt-1">
                  env: {Object.keys(server.env).join(', ')}
                </div>
              )}

              {error && (
                <div className="mt-1">
                  <Badge tone="warn">连接失败</Badge> <span className="tiny muted">{error}</span>
                </div>
              )}

              {tested && (
                <div className="mt-1">
                  {tested.ok ? (
                    <span className="tiny muted">
                      测试通过 · {tested.toolCount} 个工具
                      {tested.tools.length > 0 && (
                        <span className="mono"> · {tested.tools.slice(0, 5).join(', ')}{tested.tools.length > 5 ? ' …' : ''}</span>
                      )}
                    </span>
                  ) : (
                    <span className="tiny muted">
                      <Badge tone="warn">测试失败</Badge> {tested.error ?? '未知错误'}
                    </span>
                  )}
                </div>
              )}

              <div className="tiny mute mt-1">
                状态来自已保存的配置；修改后请点击「保存设置」，MCP 工具列表会在保存后重新加载。
              </div>
            </div>
          );
        })}
      </div>

      {adding && (
        <div className="panel mt-3">
          <div className="small strong mb-2">新增 MCP 服务器</div>

          <div className="form-grid">
            <Field label="id" hint="唯一标识，会进入工具名前缀 mcp__<id>__<tool>">
              <Input value={form.id} placeholder="例如 filesystem" onChange={(event) => patch({ id: event.target.value })} />
            </Field>
            <Field label="名称">
              <Input value={form.name} placeholder="例如 本地文件系统" onChange={(event) => patch({ name: event.target.value })} />
            </Field>

            <Field label="传输方式" className="span-2">
              <Segmented
                value={form.transport}
                options={[
                  { value: 'stdio', label: 'stdio（本地进程）' },
                  { value: 'http', label: 'http（远程 JSON-RPC）' },
                ]}
                onChange={(transport) => patch({ transport })}
              />
            </Field>

            {form.transport === 'stdio' ? (
              <>
                <Field label="command" className="span-2" hint="stdio 必填，例如 npx">
                  <Input value={form.command} placeholder="npx" onChange={(event) => patch({ command: event.target.value })} />
                </Field>
                <Field label="args（空格分隔）" className="span-2">
                  <Input
                    value={form.args}
                    placeholder="-y @modelcontextprotocol/server-filesystem /tmp"
                    onChange={(event) => patch({ args: event.target.value })}
                  />
                </Field>
                <Field label="env（每行 KEY=VALUE）" className="span-2">
                  <Textarea rows={3} value={form.env} placeholder={'API_KEY=xxx\nLOG_LEVEL=info'} onChange={(event) => patch({ env: event.target.value })} />
                </Field>
              </>
            ) : (
              <Field label="url" className="span-2" hint="http 必填，JSON-RPC 端点">
                <Input value={form.url} placeholder="http://127.0.0.1:3001/mcp" onChange={(event) => patch({ url: event.target.value })} />
              </Field>
            )}
          </div>

          <div className="mt-2">
            <Checkbox checked={form.enabled} onChange={(checked) => patch({ enabled: checked })} label="启用该服务器" />
          </div>

          {formError && (
            <div className="mt-2">
              <Badge tone="warn">校验失败</Badge> <span className="small muted">{formError}</span>
            </div>
          )}

          <div className="toolbar mt-3">
            <Button variant="ghost" onClick={() => { setForm(EMPTY_FORM); setFormError(null); setAdding(false); }}>
              取消
            </Button>
            <Button variant="primary" onClick={submit}>
              加入草稿
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除 MCP 服务器"
        message={
          <span>
            确认从配置中删除 <span className="mono">{deleteTarget?.name ?? ''}</span>（{deleteTarget?.id ?? ''}）？
            点击「保存设置」后生效。
          </span>
        }
        confirmLabel="删除"
        danger
        onConfirm={() => deleteTarget && remove(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
