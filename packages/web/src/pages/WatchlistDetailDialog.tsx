/**
 * 标的详情浮窗 — owner: web-ai-pages.
 *
 * Reuses the shared instrument sections (`MarketSeriesPanel` / `ProfilePanel`)
 * so the K线/净值图与基本面渲染与其他详情页保持一致。
 */
import { useEffect, useState } from 'react';
import { INSTRUMENT_TYPE_LABELS, MARKET_CURRENCY } from '@aia/shared';
import type { UpdateWatchItemInput, WatchlistDetail } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync } from '../api/hooks';
import {
  clamp,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtNum,
  fmtPct,
  fmtPrice,
  fmtShares,
  fmtSignedMoney,
  pnlClass,
  safeNumber,
} from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Disclosure,
  ErrorAlert,
  Field,
  Input,
  KV,
  Loading,
  MarketTag,
  Modal,
  Tabs,
  Textarea,
  useToast,
} from '../components/ui';
import { MarketSeriesPanel, ProfilePanel, markersFromTransactions } from '../components/InstrumentDetailSections';
import { FinancialsPanel } from '../components/FinancialsPanel';
import { Markdown } from '../components/markdown/Markdown';

interface EditDraft {
  qualityScore: string;
  targetPrice: string;
  expectedReturn: string;
  /** 预期收益的到达期限（自由文本，例如「6-12 个月」）。 */
  expectedReturnHorizon: string;
  note: string;
  thesis: string;
}

function toEditDraft(item: WatchlistDetail): EditDraft {
  return {
    qualityScore: String(item.qualityScore ?? 0),
    targetPrice: String(item.targetPrice ?? 0),
    expectedReturn: String(item.expectedReturn ?? 0),
    expectedReturnHorizon: item.expectedReturnHorizon ?? '',
    note: item.note ?? '',
    thesis: item.thesis ?? '',
  };
}

export function WatchlistDetailDialog(props: { id: string | null; onClose: () => void; onChanged?: () => void }) {
  const { id, onClose, onChanged } = props;
  const toast = useToast();
  const state = useAsync<WatchlistDetail | null>(
    () => (id ? api.watchlist.get(id) : Promise.resolve(null)),
    [id],
  );
  const detail = state.data;
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'overview' | 'ai'>('overview');

  useEffect(() => {
    setEdit(detail ? toEditDraft(detail) : null);
  }, [detail]);

  // 换标的时回到「概览」，不要停留在上一个标的的 AI 页签。
  useEffect(() => {
    setTab('overview');
  }, [id]);

  const currency = detail?.holding?.currency;
  const draft = edit ?? (detail ? toEditDraft(detail) : null);

  async function save() {
    if (!id || !detail || !draft) return;
    const quality = safeNumber(draft.qualityScore, Number.NaN);
    const target = safeNumber(draft.targetPrice, Number.NaN);
    const expected = safeNumber(draft.expectedReturn, Number.NaN);
    if (!Number.isFinite(quality) || !Number.isFinite(target) || !Number.isFinite(expected)) {
      toast.error('保存失败', '优质评估 / 目标价 / 预期收益必须是数字');
      return;
    }
    const input: UpdateWatchItemInput = {};
    const nextQuality = clamp(quality, 0, 100);
    if (nextQuality !== detail.qualityScore) input.qualityScore = nextQuality;
    if (target !== detail.targetPrice) input.targetPrice = target;
    if (expected !== detail.expectedReturn) input.expectedReturn = expected;
    if (draft.expectedReturnHorizon !== (detail.expectedReturnHorizon ?? '')) {
      input.expectedReturnHorizon = draft.expectedReturnHorizon;
    }
    if (draft.note !== (detail.note ?? '')) input.note = draft.note;
    if (draft.thesis !== (detail.thesis ?? '')) input.thesis = draft.thesis;
    if (Object.keys(input).length === 0) {
      toast.info('没有需要保存的修改');
      return;
    }

    setSaving(true);
    try {
      await api.watchlist.update(id, input);
      toast.success('标的已更新');
      state.reload();
      onChanged?.();
    } catch (error) {
      const err = toApiError(error);
      toast.error('保存失败', err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={id !== null}
      title={detail ? `标的详情 · ${detail.name}` : '标的详情'}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          <Button variant="primary" loading={saving} disabled={!detail} onClick={() => void save()}>
            保存修改
          </Button>
        </>
      }
    >
      {state.loading && !detail && <Loading label="正在加载标的详情…" />}
      <ErrorAlert error={state.error} onRetry={state.reload} />

      {detail && (
        <>
          <Card
            title={
              <span className="center gap-2">
                基本信息
                <Badge tone={detail.source === 'ai' ? 'ai' : 'manual'}>{detail.source === 'ai' ? 'AI 创建' : '手动创建'}</Badge>
                {detail.type === 'fund' && <Badge>场外基金</Badge>}
              </span>
            }
          >
            <KV
              items={[
                ['标的名称', detail.name || '—'],
                ['市场代码', <span className="mono">{detail.code}</span>],
                ['市场', <MarketTag market={detail.market} />],
                ['类型', INSTRUMENT_TYPE_LABELS[detail.type]],
                ['加入时间', fmtDateTime(detail.createdAt)],
                ['加入时价格', fmtPrice(detail.initialPrice, currencyFor(detail.market))],
                ['最新价', fmtPrice(detail.price, currencyFor(detail.market))],
                [
                  '推荐后涨跌',
                  <span className={pnlClass(detail.changeSinceAddedPct)}>
                    {fmtPct(detail.changeSinceAddedPct)}（{fmtSignedMoney(detail.changeSinceAdded, currencyFor(detail.market))}）
                  </span>,
                ],
                ['优质评估', `${fmtNum(detail.qualityScore, 0)} / 100`],
                ['目标价', fmtPrice(detail.targetPrice, currencyFor(detail.market))],
                ['预期收益', fmtPct(detail.expectedReturn)],
                ['预期期限', detail.expectedReturnHorizon || '—'],
                ['AI 总结时间', fmtDateTime(detail.aiSummaryAt)],
              ]}
            />

            {detail.holding ? (
              <>
                <div className="divider" />
                <div className="small strong mb-2">我的持仓</div>
                <div className="grid-4">
                  <Metric label="持有份额" value={fmtShares(detail.holding.shares)} />
                  <Metric label="成本均价" value={fmtPrice(detail.holding.avgCost, detail.holding.currency)} />
                  <Metric label="持仓成本" value={fmtMoney(detail.holding.cost, detail.holding.currency)} />
                  <Metric label="持仓市值" value={fmtMoney(detail.holding.marketValue, detail.holding.currency)} />
                  <Metric
                    label="浮动盈亏"
                    value={fmtSignedMoney(detail.holding.unrealizedPnl, detail.holding.currency)}
                    tone={detail.holding.unrealizedPnl}
                  />
                  <Metric label="浮动盈亏%" value={fmtPct(detail.holding.unrealizedPnlPct)} tone={detail.holding.unrealizedPnlPct} />
                </div>
              </>
            ) : (
              <div className="mt-3">
                <Alert tone="info">尚未持有该标的。可在「我的资产」新增买入交易，或在「AI 投资建议」确认买入后自动出现在这里。</Alert>
              </div>
            )}
          </Card>

          <Tabs
            ariaLabel="标的详情分页"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'overview', label: '概览' },
              {
                value: 'ai',
                label: 'AI 分析',
                badge: detail.aiSummary ? <Badge tone="ai">已生成</Badge> : undefined,
              },
            ]}
          />

          {tab === 'overview' ? (
            <>
              <MarketSeriesPanel
                instrument={{ market: detail.market, code: detail.code, type: detail.type, name: detail.name }}
                markers={markersFromTransactions(detail.transactions)}
                initialRange="1y"
                height="md"
              />

              <ProfilePanel instrument={{ market: detail.market, code: detail.code, type: detail.type, name: detail.name }} />

              {/* 财报体积大且不是每次都要看 → 默认折叠，避免弹窗被拉得很长。 */}
              <Disclosure
                title="财务报表（三表）"
                summary="利润表 · 资产负债表 · 现金流量表（点击展开）"
              >
                <FinancialsPanel instrument={{ market: detail.market, code: detail.code, type: detail.type, name: detail.name }} />
              </Disclosure>

              <Card title="人工修正" actions={<span className="tiny mute">保存后立即生效</span>}>
                {draft && (
                  <>
                    <div className="form-grid mb-3">
                      <Field label="优质评估（0–100）">
                        <Input
                          inputMode="decimal"
                          value={draft.qualityScore}
                          onChange={(event) => setEdit({ ...draft, qualityScore: event.target.value })}
                        />
                      </Field>
                      <Field label={`目标价（${currencyFor(detail.market)}）`}>
                        <Input
                          inputMode="decimal"
                          value={draft.targetPrice}
                          onChange={(event) => setEdit({ ...draft, targetPrice: event.target.value })}
                        />
                      </Field>
                      <Field label="预期收益（%）">
                        <Input
                          inputMode="decimal"
                          value={draft.expectedReturn}
                          onChange={(event) => setEdit({ ...draft, expectedReturn: event.target.value })}
                        />
                      </Field>
                      <Field label="预期期限" hint="多久达到上面的预期收益">
                        <Input
                          value={draft.expectedReturnHorizon}
                          placeholder="例如 6-12 个月 / 1-3 年"
                          maxLength={40}
                          onChange={(event) => setEdit({ ...draft, expectedReturnHorizon: event.target.value })}
                        />
                      </Field>
                    </div>
                    <Field label="投资逻辑（thesis）" className="mb-3">
                      <Textarea
                        rows={3}
                        value={draft.thesis}
                        placeholder="记录买入/持有的核心逻辑，AI 后续分析会参考"
                        onChange={(event) => setEdit({ ...draft, thesis: event.target.value })}
                      />
                    </Field>
                    <Field label="备注">
                      <Textarea
                        rows={2}
                        value={draft.note}
                        placeholder="个人备注，例如计划买入价位、跟踪要点"
                        onChange={(event) => setEdit({ ...draft, note: event.target.value })}
                      />
                    </Field>
                  </>
                )}
              </Card>
            </>
          ) : (
            <Card
              title={
                <span className="center gap-2">
                  AI 分析总结
                  {detail.aiSummaryAt && <span className="tiny mute">更新于 {fmtDateTime(detail.aiSummaryAt)}</span>}
                </span>
              }
            >
              {detail.aiSummary ? (
                /* AI 分析以 Markdown 存储：这里渲染成带标题层级、指标条与语义数字的报告。 */
                <Markdown text={detail.aiSummary} />
              ) : (
                <div className="mute small">AI 尚未生成分析总结；点击「AI 标的分析」后由 Agent 写入。</div>
              )}
            </Card>
          )}

          <Card title={`分红情况（${detail.dividends.length}）`}>
            {detail.dividends.length === 0 ? (
              <div className="mute small">暂无分红记录（或数据源未提供）。</div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>报告期</th>
                      <th>方案</th>
                      <th className="num">每股派息</th>
                      <th>除权除息日</th>
                      <th>股权登记日</th>
                      <th>派息日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.dividends.slice(0, 12).map((item, index) => (
                      <tr key={`${item.period}-${index}`}>
                        <td>{item.period || '—'}</td>
                        <td>{item.plan || '—'}</td>
                        <td className="num">{item.cashPerShare ? fmtNum(item.cashPerShare, 4) : '—'}</td>
                        <td>{fmtDate(item.exDate)}</td>
                        <td>{fmtDate(item.recordDate)}</td>
                        <td>{fmtDate(item.payDate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </Modal>
  );
}

function Metric(props: { label: string; value: string; tone?: number }) {
  const toneClass = props.tone === undefined ? '' : pnlClass(props.tone);
  return (
    <div className="panel">
      <div className="tiny mute">{props.label}</div>
      <div className={`strong ${toneClass}`} style={{ marginTop: 2 }}>
        {props.value}
      </div>
    </div>
  );
}

function currencyFor(market: WatchlistDetail['market']): string {
  return MARKET_CURRENCY[market];
}
