/**
 * SettingsPage — owner: web-ai-pages.
 * 本地草稿 + 保存按钮：AI 配置 / 投资性格 / 报告风格 / 数据源 / 预算 / 定时任务 / 备份恢复。
 */
import { useEffect, useState } from 'react';
import {
  DEFAULT_TOOL_POLICY,
  LLM_PROVIDER_CUSTOM_ID,
  LLM_PROVIDER_PRESETS,
  PERSONAS,
  REPORT_STYLES,
  matchLlmProviderPreset,
} from '@aia/shared';
import type { DataSourceConfig, LlmProviderPreset, McpServerConfig, SettingsInput, ToolPolicy } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync } from '../api/hooks';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorAlert,
  Field,
  Input,
  Loading,
  useToast,
} from '../components/ui';
import { DataSourcesCard } from './SettingsDataSources';
import { LlmProviderField } from './SettingsLlmProvider';
import { ModelField } from './SettingsModelField';
import { BackupCard } from './SettingsBackup';
import { DangerZoneCard } from './SettingsDangerZone';
import { ToolPolicyCard } from './SettingsToolPolicy';
import { McpServersCard } from './SettingsMcpServers';
import { SchedulesCard } from './SettingsSchedules';
import { buildInput, isDirty, toDraft, type Draft } from './settingsDraft';

/**
 * 数据源槽位的 Key 只允许来自本地输入：服务端理应不回传明文，这里再把响应中的
 * `apiKey` 一律剔除，确保草稿/基线都不会把服务端 Key 带进 UI 或被重新下发。
 */
function stripDataSourceKeys(config: DataSourceConfig): DataSourceConfig {
  const next: Record<string, unknown> = { ...(config ?? {}) };
  for (const [slot, choice] of Object.entries(config ?? {})) {
    if (!choice || typeof choice !== 'object') continue;
    const clone: Record<string, unknown> = { ...(choice as unknown as Record<string, unknown>) };
    delete clone.apiKey;
    next[slot] = clone;
  }
  return next as unknown as DataSourceConfig;
}

/**
 * 保存时剔除服务端的只读回执字段（`hasApiKey` / `apiKeyMasked`），只把可写字段发回；
 * 某槽位没有本地新 Key 时对象里本来就没有 `apiKey`，因此不会下发该字段。
 */
function stripReadonlyDataSourceFields(config: DataSourceConfig): DataSourceConfig {
  const next: Record<string, unknown> = { ...(config ?? {}) };
  for (const [slot, choice] of Object.entries(config ?? {})) {
    if (!choice || typeof choice !== 'object') continue;
    const clone: Record<string, unknown> = { ...(choice as unknown as Record<string, unknown>) };
    delete clone.hasApiKey;
    delete clone.apiKeyMasked;
    next[slot] = clone;
  }
  return next as unknown as DataSourceConfig;
}

/** `toolPolicy` / `mcpServers` 的草稿副本：与 settingsDraft 的其它字段一样，只在保存时整体提交。 */
function cloneToolPolicy(policy: ToolPolicy | undefined): ToolPolicy {
  const source = policy ?? DEFAULT_TOOL_POLICY;
  return { requireWriteApproval: Boolean(source.requireWriteApproval), deny: [...(source.deny ?? [])] };
}

function cloneMcpServers(servers: McpServerConfig[] | undefined): McpServerConfig[] {
  return (servers ?? []).map((server) => ({
    ...server,
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
  }));
}

/* ─────────────────────────────────── page ─────────────────────────────────── */

export function SettingsPage() {
  const toast = useToast();
  const state = useAsync(() => api.settings.get(), []);
  const dashboard = useAsync(() => api.dashboard(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  /** 工具策略 / MCP 服务器同样走「草稿 + 保存」：草稿值与保存时的基线分开保存。 */
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy | null>(null);
  const [toolPolicyBase, setToolPolicyBase] = useState<ToolPolicy | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[] | null>(null);
  const [mcpServersBase, setMcpServersBase] = useState<McpServerConfig[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  /** 高级参数（快速模型 / 温度 / 最大输出 / 超时）默认折叠，避免干扰只想填 Key 的用户。 */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; model: string; latencyMs: number; message: string } | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosis, setDiagnosis] = useState<{
    ok: boolean;
    verdict: string;
    steps: { id: string; label: string; ok: boolean; detail: string }[];
  } | null>(null);

  useEffect(() => {
    if (!state.data) return;
    const next = toDraft(state.data);
    next.dataSources = stripDataSourceKeys(next.dataSources);
    setDraft(next);
    setBase(next);
    const policy = cloneToolPolicy(state.data.toolPolicy);
    setToolPolicy(policy);
    setToolPolicyBase(cloneToolPolicy(state.data.toolPolicy));
    const servers = cloneMcpServers(state.data.mcpServers);
    setMcpServers(servers);
    setMcpServersBase(cloneMcpServers(state.data.mcpServers));
  }, [state.data]);

  const settings = state.data;
  const toolPolicyDirty = toolPolicy && toolPolicyBase ? JSON.stringify(toolPolicy) !== JSON.stringify(toolPolicyBase) : false;
  const mcpServersDirty = mcpServers && mcpServersBase ? JSON.stringify(mcpServers) !== JSON.stringify(mcpServersBase) : false;
  const dirty = (draft && base ? isDirty(draft, base) : false) || toolPolicyDirty || mcpServersDirty;

  function patch(changes: Partial<Draft>) {
    setDraft((previous) => (previous ? { ...previous, ...changes } : previous));
  }

  /** 选择供应商预设：填入 Base URL 与推荐模型（模型名之后仍可手动改写）。 */
  function applyProviderPreset(preset: LlmProviderPreset) {
    patch({ baseUrl: preset.baseUrl, model: preset.model, fastModel: preset.fastModel });
  }

  /** 放弃修改：把全部草稿（含工具策略 / MCP）恢复到最后一次服务端状态。 */
  function reset() {
    if (base) setDraft({ ...base });
    if (toolPolicyBase) setToolPolicy(cloneToolPolicy(toolPolicyBase));
    if (mcpServersBase) setMcpServers(cloneMcpServers(mcpServersBase));
  }

  async function save() {
    if (!draft || !base) return;
    let input: SettingsInput;
    try {
      input = buildInput(draft, base);
      if (input.dataSources) input.dataSources = stripReadonlyDataSourceFields(input.dataSources as DataSourceConfig);
      // 整体替换语义：只在草稿与基线不同时下发，避免覆盖服务端并发更新。
      if (toolPolicyDirty && toolPolicy) input.toolPolicy = toolPolicy;
      if (mcpServersDirty && mcpServers) input.mcpServers = mcpServers;
    } catch (error) {
      toast.error('无法保存', (error as Error).message);
      return;
    }
    if (Object.keys(input).length === 0) {
      toast.info('没有需要保存的修改');
      return;
    }
    setSaving(true);
    try {
      const updated = await api.settings.update(input);
      state.setData(updated);
      toast.success('设置已保存', '新的配置将在下一次 AI 运行时生效');
    } catch (error) {
      const err = toApiError(error);
      toast.error('保存失败', err.isNotConfigured ? '服务端未配置 API Key（请先保存 AI 配置）' : err.message);
    } finally {
      setSaving(false);
    }
  }

  async function clearApiKey() {
    setSaving(true);
    try {
      const updated = await api.settings.update({ apiKey: null });
      state.setData(updated);
      toast.success('API Key 已清除');
    } catch (error) {
      toast.error('清除失败', toApiError(error).message);
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.settings.testLlm({
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        apiKey: draft.apiKey.trim() || undefined,
      });
      setTestResult(result);
      if (result.ok) toast.success('连接成功', `${result.model} · ${result.latencyMs} ms`);
      else toast.warn('连接失败', result.message);
    } catch (error) {
      const err = toApiError(error);
      setTestResult({ ok: false, model: '', latencyMs: 0, message: err.message });
      toast.error('连接失败', err.message);
    } finally {
      setTesting(false);
    }
  }

  async function runDiagnosis() {
    if (!draft) return;
    setDiagnosing(true);
    setDiagnosis(null);
    try {
      const result = await api.settings.diagnose({
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        apiKey: draft.apiKey.trim() || undefined,
      });
      setDiagnosis(result);
      if (result.ok) toast.success('诊断通过', result.verdict);
      else toast.warn('诊断发现问题', result.verdict);
    } catch (error) {
      toast.error('诊断失败', toApiError(error).message);
    } finally {
      setDiagnosing(false);
    }
  }

  if (state.loading && !settings) return <Loading label="正在加载设置…" />;
  if (state.error && !settings) {
    return (
      <div>
        <ErrorAlert error={state.error} onRetry={state.reload} />
        <div className="tiny mute mt-2">无法读取设置，请确认服务端已启动。</div>
      </div>
    );
  }
  if (!draft || !base || !settings || !toolPolicy || !toolPolicyBase || !mcpServers || !mcpServersBase) return <Loading />;

  return (
    <div className="flex" style={{ flexDirection: 'column', gap: 14 }}>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />

      <Card
        title={
          <span className="center gap-2">
            AI 配置
            {settings.hasApiKey ? <Badge tone="ok">已配置 Key</Badge> : <Badge tone="warn">未配置 Key</Badge>}
          </span>
        }
        actions={
          <div className="toolbar">
            <Button size="sm" variant="ghost" loading={diagnosing} onClick={() => void runDiagnosis()}>
              诊断
            </Button>
            <Button size="sm" loading={testing} onClick={() => void testConnection()}>
              测试连接
            </Button>
          </div>
        }
      >
        <div className="form-grid">
          <LlmProviderField baseUrl={draft.baseUrl} onPick={applyProviderPreset} />
          <Field label="Base URL" className="span-2">
            <Input
              value={draft.baseUrl}
              placeholder="https://api.deepseek.com/v1"
              onChange={(event) => patch({ baseUrl: event.target.value })}
            />
          </Field>
          <Field
            label="API Key"
            className="span-2"
            hint={draft.apiKey.trim() === '' ? '留空表示不修改；当前已保存的 Key 不会回显。' : '将用新填写的 Key 覆盖服务端已保存的 Key。'}
          >
            <Input
              type="password"
              value={draft.apiKey}
              placeholder={settings.apiKeyMasked || '未设置'}
              onChange={(event) => patch({ apiKey: event.target.value })}
            />
          </Field>
          <Field label="模型" className="span-2">
            <ModelField
              value={draft.model}
              onChange={(model) => patch({ model })}
              baseUrl={draft.baseUrl}
              apiKey={draft.apiKey}
            />
          </Field>
          <Field label="每次分析生成的候选标的数量上限" hint="只影响「标的分析」产出的候选数量，与模型无关">
            <Input
              inputMode="decimal"
              value={draft.watchlistCandidateLimit}
              onChange={(event) => patch({ watchlistCandidateLimit: event.target.value })}
            />
          </Field>
          <Field
            label="标的淘汰确认次数"
            hint="连续多少次分析都确认「不再适合」后才自动移除；0 = 只标记不删除。有持仓、手动添加、有待处理建议的标的永不自动删除"
            className="span-2"
          >
            <Input
              inputMode="decimal"
              value={draft.watchlistRetireDeleteRuns}
              onChange={(event) => patch({ watchlistRetireDeleteRuns: event.target.value })}
            />
          </Field>
        </div>

        <div className="divider" />

        <div className="between wrap gap-2">
          <Button size="sm" variant="ghost" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
            {advancedOpen ? '▾' : '▸'} 高级设置（快速模型 · 温度 · 最大输出 · 超时）
          </Button>
          {!advancedOpen && (
            <span className="tiny mute">
              温度 {draft.temperature || '—'} · 最大输出 {draft.maxTokens || '—'} · 超时 {draft.timeoutMs || '—'} ms · 快速模型{' '}
              {draft.fastModel.trim() || '未设置'}
            </span>
          )}
        </div>

        {advancedOpen && (
          <div className="form-grid mt-3">
            <Field label="快速模型（可选）" className="span-2">
              <ModelField
                value={draft.fastModel}
                onChange={(fastModel) => patch({ fastModel })}
                baseUrl={draft.baseUrl}
                apiKey={draft.apiKey}
              />
            </Field>
            <Field
              label="temperature（随机性）"
              hint="0 = 输出几乎固定，0.3 = 金融分析推荐（稳定、可复现），1 = 更发散。它只是随机性开关，调高不会更聪明。"
            >
              <Input inputMode="decimal" value={draft.temperature} onChange={(event) => patch({ temperature: event.target.value })} />
            </Field>
            <Field
              label="最大输出 maxTokens"
              hint="单次回复的长度上限，不是智能开关。太小会让长报告被截断；思考型模型（如 DeepSeek 思考模式）会把思考过程也算进去。"
            >
              <Input inputMode="decimal" value={draft.maxTokens} onChange={(event) => patch({ maxTokens: event.target.value })} />
            </Field>
            <Field
              label="超时 timeoutMs（毫秒）"
              hint="单次请求的最长等待时间。深度分析或思考模型建议 180000（3 分钟）以上；网络慢时先调大这个。"
            >
              <Input inputMode="decimal" value={draft.timeoutMs} onChange={(event) => patch({ timeoutMs: event.target.value })} />
            </Field>
            <div className="tiny mute span-2">
              以上三项保持默认即可满足绝大多数场景；只有出现「回答被截断」「总是超时」时才需要调整。
            </div>
          </div>
        )}

        {settings.hasApiKey && (
          <div className="mt-3">
            <Button size="sm" variant="danger" disabled={saving} onClick={() => void clearApiKey()}>
              清除已保存的 API Key
            </Button>
          </div>
        )}

        {testResult && (
          <div className="mt-3">
            <Alert tone={testResult.ok ? 'info' : 'error'}>
              {testResult.ok ? '连接成功' : '连接失败'}
              {testResult.model ? ` · 模型 ${testResult.model}` : ''}
              {testResult.latencyMs ? ` · 延迟 ${testResult.latencyMs} ms` : ''}
              {testResult.message && <div className="tiny mt-1">{testResult.message}</div>}
            </Alert>
          </div>
        )}

        {diagnosis && (
          <div className="mt-3">
            <Alert tone={diagnosis.ok ? 'info' : 'error'}>
              <div className="strong">{diagnosis.ok ? '诊断通过' : '诊断发现问题'}</div>
              <div className="tiny mt-1">{diagnosis.verdict}</div>
              <ul className="tiny mt-2" style={{ margin: 0, paddingLeft: 18 }}>
                {diagnosis.steps.map((step) => (
                  <li key={step.id} style={step.ok ? undefined : { color: 'var(--warn)' }}>
                    {step.ok ? '✓' : '✗'} {step.label}：{step.detail}
                  </li>
                ))}
              </ul>
            </Alert>
          </div>
        )}
      </Card>

      <Card title="投资性格" actions={<span className="tiny mute">决定 Agent 选股与建议的取向</span>}>
        <div className="grid-3">
          {PERSONAS.map((persona) => {
            const active = draft.persona === persona.id;
            return (
              <button
                key={persona.id}
                type="button"
                className="panel"
                onClick={() => patch({ persona: persona.id })}
                style={{
                  textAlign: 'left',
                  font: 'inherit',
                  color: 'inherit',
                  cursor: 'pointer',
                  width: '100%',
                  borderColor: active ? 'var(--accent)' : undefined,
                  background: active ? 'var(--accent-soft)' : undefined,
                }}
              >
                <div className="between">
                  <span className="strong">{persona.label}</span>
                  <span className="tiny mute">
                    风险 {persona.riskLevel}/5 {active ? '· 已选' : ''}
                  </span>
                </div>
                <div className="tiny muted mt-1">{persona.description}</div>
                <div className="tiny mute mt-1">
                  持有期 {persona.horizon} · 优质评估门槛 {persona.qualityGate}
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="AI 报告风格">
        <div className="grid-2">
          {REPORT_STYLES.map((style) => {
            const active = draft.reportStyle === style.id;
            return (
              <button
                key={style.id}
                type="button"
                className="panel"
                onClick={() => patch({ reportStyle: style.id })}
                style={{
                  textAlign: 'left',
                  font: 'inherit',
                  color: 'inherit',
                  cursor: 'pointer',
                  width: '100%',
                  borderColor: active ? 'var(--accent)' : undefined,
                  background: active ? 'var(--accent-soft)' : undefined,
                }}
              >
                <div className="between">
                  <span className="strong">{style.label}</span>
                  {active && <Badge tone="ok">已选</Badge>}
                </div>
                <div className="tiny muted mt-1">{style.description}</div>
              </button>
            );
          })}
        </div>
      </Card>

      <DataSourcesCard value={draft.dataSources} onChange={(next) => patch({ dataSources: next })} />

      <ToolPolicyCard value={toolPolicy} onChange={setToolPolicy} />

      <McpServersCard value={mcpServers} onChange={setMcpServers} />

      <Card title="月投资预算" actions={<span className="tiny mute">按各自币种统计当月买入成交额</span>}>
        <div className="form-grid">
          <Field label="A股预算（CNY）">
            <Input inputMode="decimal" value={draft.budgetCN} onChange={(event) => patch({ budgetCN: event.target.value })} />
          </Field>
          <Field label="港股预算（HKD）">
            <Input inputMode="decimal" value={draft.budgetHK} onChange={(event) => patch({ budgetHK: event.target.value })} />
          </Field>
          <Field label="美股预算（USD）">
            <Input inputMode="decimal" value={draft.budgetUS} onChange={(event) => patch({ budgetUS: event.target.value })} />
          </Field>
        </div>
        <div className="mt-3">
          <Checkbox
            checked={draft.enforceBudget}
            onChange={(checked) => patch({ enforceBudget: checked })}
            label="严格执行预算：预算耗尽的市场不再产生买入建议"
          />
        </div>
      </Card>

      {/* AI 定时任务：数组形态，可并存多个任务（触发方式与步骤各自独立）。 */}
      <SchedulesCard
        value={draft.schedules}
        onChange={(next) => patch({ schedules: next })}
        nextRuns={dashboard.data?.signals.nextRuns ?? []}
      />

      <BackupCard />

      {/* 清空后必须重读设置（可能已恢复默认）与仪表盘（下次运行时间/计数会变）。 */}
      <DangerZoneCard
        onCleared={() => {
          state.reload();
          dashboard.reload();
        }}
      />

      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </div>
  );
}

function SaveBar(props: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  return (
    <Card>
      <div className="between wrap gap-2">
        <div className="center gap-2">
          {props.dirty ? <Badge tone="warn">已修改</Badge> : <Badge tone="ok">未修改</Badge>}
          <span className="tiny mute">
            {props.dirty ? '修改仅保存在本地草稿，点击「保存设置」后生效。' : '当前设置与服务端一致。'}
          </span>
        </div>
        <div className="toolbar">
          <Button variant="ghost" disabled={!props.dirty || props.saving} onClick={props.onReset}>
            放弃修改
          </Button>
          <Button variant="primary" loading={props.saving} disabled={!props.dirty} onClick={props.onSave}>
            保存设置
          </Button>
        </div>
      </div>
    </Card>
  );
}
