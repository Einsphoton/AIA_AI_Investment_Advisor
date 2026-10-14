/**
 * 数据源配置区块 — owner: web-ai-pages.
 * 逐槽位（A股/港股/美股 × 股票/基金 + 网页搜索）选择 provider 与可选 API Key。
 *
 * 安全约定（配合服务端脱敏）：服务端**永不回传数据源 Key 明文**，本组件也不回显任何
 * 服务端 Key —— 输入框只由本地草稿驱动，初始为空；留空 = 不修改服务端已存的 Key，
 * 填写新 Key 才会覆盖，且没有新 Key 时保存不会下发 `apiKey` 字段。
 */
import { useState } from 'react';
import {
  DATA_SOURCE_SLOTS,
  SOURCE_CATALOGUE,
  type DataSourceCatalogueEntry,
  type DataSourceChoice,
  type DataSourceConfig,
  type DataSourceSlot,
} from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync } from '../api/hooks';
import { Badge, Button, Card, Dropdown, Input, Loading } from '../components/ui';

/** 网页搜索类数据源（后端 catalogue 的 id 固定）。 */
const WEB_SEARCH_IDS = ['tavily', 'serper', 'brave', 'bing', 'duckduckgo'];

interface ProbeRow {
  provider: string;
  ok: boolean;
  latencyMs: number;
  message: string;
}

/**
 * 只读取**本地草稿**中用户新填的 Key。
 * 服务端响应里的 `apiKey` 已由 Settings 页在写入草稿前剔除（stripDataSourceKeys），
 * 因此这里拿到的值只可能来自用户输入，绝不会回显服务端保存的 Key。
 */
function localKeyDraft(choice: DataSourceChoice | undefined): string {
  return choice?.apiKey ?? '';
}

/**
 * 槽位「已存 Key」的展示信息：只涉及 `hasApiKey` / `apiKeyMasked` 与 `enabled`，绝不读取明文。
 * 这两个字段已由 `packages/shared` 的 `DataSourceChoice` 声明（响应专属），无需类型断言。
 * 字段缺失时回退到「需 Key 且服务端判定可用 ⇒ 已存 Key」的推断。
 */
function readStoredKey(
  choice: DataSourceChoice,
  requiresKey: boolean,
): { hasStored: boolean; masked: string; inferred: boolean } {
  const masked = typeof choice.apiKeyMasked === 'string' && choice.apiKeyMasked.length > 0 ? choice.apiKeyMasked : '••••••••';
  if (typeof choice.hasApiKey === 'boolean') return { hasStored: choice.hasApiKey, masked, inferred: false };
  if (typeof choice.apiKeyMasked === 'string' && choice.apiKeyMasked.length > 0) {
    return { hasStored: true, masked, inferred: true };
  }
  return { hasStored: requiresKey && Boolean(choice.enabled), masked, inferred: true };
}

export function DataSourcesCard(props: { value: DataSourceConfig; onChange: (next: DataSourceConfig) => void }) {
  const catalogue = useAsync(() => api.settings.dataSources(), []);
  const [probing, setProbing] = useState(false);
  const [probeRows, setProbeRows] = useState<ProbeRow[] | null>(null);

  function slotOptions(slot: DataSourceSlot): DataSourceCatalogueEntry[] {
    const fromServer = catalogue.data?.slots.find((entry) => entry.slot === slot)?.options;
    if (fromServer && fromServer.length > 0) return fromServer;
    const meta = DATA_SOURCE_SLOTS.find((entry) => entry.slot === slot);
    if (!meta) return [];
    return SOURCE_CATALOGUE.filter((entry) => entry.markets.includes(meta.market) && entry.kinds.includes(meta.kind));
  }

  function searchOptions(): DataSourceCatalogueEntry[] {
    const fromServer = catalogue.data?.providers.filter((entry) => WEB_SEARCH_IDS.includes(entry.id));
    if (fromServer && fromServer.length > 0) return fromServer;
    return SOURCE_CATALOGUE.filter((entry) => WEB_SEARCH_IDS.includes(entry.id));
  }

  function updateSlot(slot: DataSourceSlot, next: DataSourceChoice) {
    props.onChange({ ...props.value, [slot]: next });
  }

  /** 写本地 Key 草稿：留空 = 删除该字段 ⇒ 保存时不下发 apiKey，服务端保留已存的 Key。 */
  function setSlotKey(slot: keyof DataSourceConfig, raw: string) {
    const next: DataSourceChoice = { ...props.value[slot] };
    if (raw.trim()) next.apiKey = raw;
    else delete next.apiKey;
    props.onChange({ ...props.value, [slot]: next });
  }

  async function probe() {
    setProbing(true);
    try {
      setProbeRows(await api.settings.probe());
    } catch (error) {
      setProbeRows([{ provider: '—', ok: false, latencyMs: 0, message: toApiError(error).message }]);
    } finally {
      setProbing(false);
    }
  }

  return (
    <Card
      title="数据源配置"
      actions={
        <Button size="sm" variant="ghost" loading={probing} onClick={() => void probe()}>
          探测可用性
        </Button>
      }
    >
      <div className="tiny mute mb-3">
        「自动」按内置优先级链回退；指定 provider 后优先使用该数据源，若该源不可用会自动降级到其它可用源，并在结果中标注实际来源（sources / warnings）。
        「已启用 / 未启用」由服务端按当前配置计算：需要 Key 的数据源若已在服务端保存过 Key，输入框留空也仍算已启用。
      </div>

      {catalogue.loading && !catalogue.data && <Loading label="读取数据源目录…" />}

      {DATA_SOURCE_SLOTS.map((meta) => (
        <SlotRow
          key={meta.slot}
          label={meta.label}
          choice={props.value[meta.slot]}
          options={slotOptions(meta.slot)}
          newKey={localKeyDraft(props.value[meta.slot])}
          onKeyChange={(raw) => setSlotKey(meta.slot, raw)}
          onChange={(next) => updateSlot(meta.slot, next)}
        />
      ))}

      <div className="divider" />
      <div className="small strong mb-2">网页搜索源</div>
      <SlotRow
        label="Agent 联网搜索（研报 / 行业数据 / 国际局势）"
        choice={props.value.webSearch}
        options={searchOptions()}
        newKey={localKeyDraft(props.value.webSearch)}
        onKeyChange={(raw) => setSlotKey('webSearch', raw)}
        onChange={(next) => props.onChange({ ...props.value, webSearch: next })}
      />

      {catalogue.error && <div className="tiny mute mt-2">数据源目录读取失败（已使用内置目录）：{catalogue.error.message}</div>}

      {probeRows && (
        <div className="mt-3">
          <div className="small strong mb-2">探测结果</div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>数据源</th>
                  <th>状态</th>
                  <th className="num">延迟</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {probeRows.map((row) => (
                  <tr key={row.provider}>
                    <td className="mono tiny">{row.provider}</td>
                    <td>{row.ok ? <Badge tone="ok">可用</Badge> : <Badge tone="warn">不可用</Badge>}</td>
                    <td className="num">{row.latencyMs ? `${row.latencyMs} ms` : '—'}</td>
                    <td className="tiny mute">{row.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}

function SlotRow(props: {
  label: string;
  choice: DataSourceChoice;
  options: DataSourceCatalogueEntry[];
  /** 本地草稿里用户新填的 Key（'' = 留空 = 不修改服务端已存 Key）。 */
  newKey: string;
  onKeyChange: (raw: string) => void;
  onChange: (next: DataSourceChoice) => void;
}) {
  const { choice, options, newKey } = props;
  const entry = options.find((option) => option.id === choice.provider);
  const requiresKey = entry?.requiresKey ?? false;
  const hasNewKey = newKey.trim().length > 0;
  const stored = readStoredKey(choice, requiresKey);
  /** 服务端 enabled 为主，叠加「本地填了新 Key」与「免 Key/auto 必然可用」。 */
  const usable = Boolean(choice.enabled) || hasNewKey || !requiresKey;

  /** 只切换 provider，不改写服务端算好的 enabled（可用性由服务端 + 本地新 Key 共同决定）。 */
  function pickProvider(provider: DataSourceChoice['provider']) {
    props.onChange({ ...choice, provider });
  }

  const placeholder = stored.hasStored
    ? `已配置（${stored.masked}）· 留空表示不修改`
    : requiresKey
      ? '未配置 · 填写新 Key 才会覆盖'
      : '无需 API Key';

  return (
    <div className="panel mb-2">
      <div className="between wrap gap-2">
        <div className="small strong">{props.label}</div>
        <div className="center gap-1">
          {requiresKey && <Badge tone="warn">需 API Key</Badge>}
          <Badge tone={usable ? 'ok' : 'default'}>{usable ? '已启用' : '未启用'}</Badge>
          {entry?.status === 'ok' && <Badge tone="ok">可达</Badge>}
          {entry?.status === 'error' && <Badge tone="warn">探测失败</Badge>}
        </div>
      </div>

      <div className="flex gap-2 wrap mt-2">
        <div style={{ flex: '1 1 260px', minWidth: 200 }}>
          <Dropdown
            value={choice.provider}
            ariaLabel={`${props.label} 数据源`}
            onChange={(next) => pickProvider(next as DataSourceChoice['provider'])}
            items={[
              { value: 'auto', label: '自动（按内置优先级链）' },
              ...options.map((option) => ({
                value: option.id,
                label: `${option.name}${option.requiresKey ? '（需 Key）' : ''}`,
              })),
            ]}
          />
        </div>
        {requiresKey && (
          <div style={{ flex: '1 1 220px', minWidth: 180 }}>
            <Input
              type="password"
              autoComplete="new-password"
              value={newKey}
              placeholder={placeholder}
              title="留空表示不修改已保存的 Key；填写新 Key 才会覆盖（点击「保存设置」后生效）"
              aria-label={`${props.label} API Key（留空表示不修改）`}
              onChange={(event) => props.onKeyChange(event.target.value)}
            />
          </div>
        )}
      </div>

      {requiresKey && (
        <div className="field-hint mt-1">
          留空表示不修改已保存的 Key；填写新 Key 才会覆盖（仅在点击「保存设置」时下发，不会在页面上回显已存的 Key）。
          {stored.hasStored && stored.inferred && '（服务端暂未返回掩码，已按启用状态推断为「已配置」）'}
        </div>
      )}
      {requiresKey && !hasNewKey && !usable && (
        <div className="field-hint mt-1">该槽位当前未启用：请填写 API Key 后保存。</div>
      )}
      {entry?.notes && <div className="field-hint mt-1">{entry.notes}</div>}
    </div>
  );
}
