/**
 * Reusable sections for the instrument detail dialogs (资产详情 / 标的详情).
 * Owner: Lead — both frontend page owners must reuse these instead of
 * re-implementing chart + profile fetching.
 */
import { useState } from 'react';
import type { InstrumentType, Market, RangeKey, BarInterval, SeriesResponse, ProfileResponse } from '@aia/shared';
import { RANGE_KEYS, RANGE_LABELS } from '@aia/shared';
import { api } from '../api/client';
import { useAsync } from '../api/hooks';
import { fmtCompact, fmtDateTime, fmtNum, fmtPct, fmtPrice, pnlClass, safeNumber } from '../format';
import { Alert, Badge, Card, Empty, Loading, Segmented } from './ui';
import { KLineChart, type TradeMarker } from './charts/KLineChart';
import { NavChart } from './charts/NavChart';

export interface InstrumentRef {
  market: Market;
  code: string;
  type: InstrumentType;
  name?: string;
  currency?: string;
}

const INTERVAL_OPTIONS: { value: BarInterval; label: string }[] = [
  { value: 'day', label: '日K' },
  { value: 'week', label: '周K' },
  { value: 'month', label: '月K' },
];

/* ───────────────────────── K线 / 净值曲线 面板 ───────────────────────────── */

export function MarketSeriesPanel(props: {
  instrument: InstrumentRef;
  markers?: TradeMarker[];
  initialRange?: RangeKey;
  height?: 'md' | 'lg';
}) {
  const { instrument, markers = [] } = props;
  const [range, setRange] = useState<RangeKey>(props.initialRange ?? '1y');
  const [interval, setInterval] = useState<BarInterval>('day');
  const isFund = instrument.type === 'fund';

  const state = useAsync<SeriesResponse>(
    () => api.market.series({ market: instrument.market, code: instrument.code, type: instrument.type, range, interval: isFund ? 'day' : interval }),
    [instrument.market, instrument.code, instrument.type, range, interval, isFund],
  );

  const series = state.data;
  const chartClass = props.height === 'md' ? 'chart chart-md' : 'chart chart-lg';

  return (
    <Card
      title={
        <span className="center gap-2">
          {isFund ? '净值曲线' : 'K 线'}
          {series && <Badge>{series.kind === 'nav' ? '单位净值' : '前复权'}</Badge>}
          {series?.sources.map((source) => (
            <Badge key={source} tone="manual">
              {source}
            </Badge>
          ))}
        </span>
      }
      actions={
        <div className="toolbar">
          <Segmented value={range} options={RANGE_KEYS.map((key) => ({ value: key, label: RANGE_LABELS[key] }))} onChange={setRange} />
          {!isFund && <Segmented value={interval} options={INTERVAL_OPTIONS} onChange={setInterval} />}
        </div>
      }
    >
      {state.loading && !series && <div className={chartClass}><Loading label="正在获取行情…" /></div>}
      {state.error && <Alert tone="error">{state.error.message}</Alert>}
      {series && series.points.length === 0 && <Empty title="暂无行情数据" hint={`${instrument.market}/${instrument.code} 未返回价格序列`} />}
      {series && series.points.length > 0 && (
        <>
          {series.kind === 'nav' ? (
            <NavChart points={series.points} markers={markers} className={chartClass} resetKey={`${instrument.code}-${range}-${series.points.length}`} />
          ) : (
            <KLineChart points={series.points} markers={markers} currency={series.currency} className={chartClass} resetKey={`${instrument.code}-${range}-${interval}-${series.points.length}`} />
          )}
          <div className="between mt-2">
            <div className="marker-legend">
              {markers.length > 0 && (
                <>
                  <span>
                    <span className="dot" style={{ background: '#e2ba55', color: '#e2ba55' }} />
                    买入
                  </span>
                  <span>
                    <span className="dot" style={{ background: '#2fbf8f', color: '#2fbf8f' }} />
                    卖出
                  </span>
                  <span>共 {markers.length} 笔交易标注</span>
                </>
              )}
              {markers.length === 0 && <span>可拖动下方滑块缩放 / 筛选时间范围</span>}
            </div>
            <div className="tiny mute">
              {series.points.length} 个数据点 · 区间 {RANGE_LABELS[range]} · {series.points[0]?.date} ~ {series.points[series.points.length - 1]?.date}
            </div>
          </div>
          {series.warnings.length > 0 && <div className="tiny mute mt-2">数据源提示：{series.warnings.join('；')}</div>}
        </>
      )}
    </Card>
  );
}

/* ────────────────────────── 基本面 / 基金 / 分红 ─────────────────────────── */

export function ProfilePanel(props: { instrument: InstrumentRef }) {
  const { instrument } = props;
  const state = useAsync<ProfileResponse>(
    () => api.market.profile({ market: instrument.market, code: instrument.code, type: instrument.type }),
    [instrument.market, instrument.code, instrument.type],
  );

  if (state.loading && !state.data) {
    return (
      <Card title="基本面 / 基金详情">
        <Loading label="正在获取基本面数据…" />
      </Card>
    );
  }
  if (state.error) {
    return (
      <Card title="基本面 / 基金详情">
        <Alert tone="error">{state.error.message}</Alert>
      </Card>
    );
  }

  const profile = state.data;
  if (!profile) return null;
  const quote = profile.quote;
  const fundamentals = profile.fundamentals;
  const fundInfo = profile.fundInfo;
  const dividends = profile.dividends ?? [];

  return (
    <Card
      title={
        <span className="center gap-2">
          基本面 / 基金详情
          {profile.sources.map((source) => (
            <Badge key={source} tone="manual">
              {source}
            </Badge>
          ))}
        </span>
      }
    >
      {quote && (
        <div className="grid-4 mb-3">
          <Metric label="最新价" value={fmtPrice(quote.price, quote.currency)} />
          <Metric label="涨跌幅" value={fmtPct(quote.changePct)} tone={quote.changePct} />
          <Metric label="昨收" value={fmtPrice(quote.prevClose, quote.currency)} />
          <Metric label="换手率" value={quote.turnoverRate ? fmtPct(quote.turnoverRate, 2, false) : '—'} />
          <Metric label="总市值" value={quote.marketCap ? fmtCompact(quote.marketCap) : '—'} />
          <Metric label="流通市值" value={quote.floatMarketCap ? fmtCompact(quote.floatMarketCap) : '—'} />
          <Metric label="PE(TTM)" value={quote.peTtm ? fmtNum(quote.peTtm, 2) : quote.pe ? fmtNum(quote.pe, 2) : '—'} />
          <Metric label="PB" value={quote.pb ? fmtNum(quote.pb, 2) : '—'} />
          <Metric label="ROE" value={quote.roe ? fmtPct(quote.roe, 2, false) : '—'} />
          <Metric label="营业收入" value={quote.revenue ? fmtCompact(quote.revenue) : '—'} />
          <Metric label="所属行业" value={quote.industry || '—'} />
          <Metric label="行情时间" value={fmtDateTime(quote.updatedAt)} />
        </div>
      )}

      {fundamentals && fundamentals.metrics.length > 0 && (
        <div className="mb-3">
          <div className="small strong mb-2">
            财务指标 {fundamentals.reportDate ? <span className="mute tiny">（报告期 {fundamentals.reportDate.slice(0, 10)}）</span> : null}
          </div>
          <div className="grid-4">
            {fundamentals.metrics.map((metric) => (
              <Metric
                key={metric.key}
                label={metric.label}
                value={`${fmtNum(metric.value, 2)}${metric.unit && metric.unit !== '%' ? ` ${metric.unit}` : metric.unit === '%' ? '%' : ''}`}
                hint={metric.yoy !== undefined && metric.yoy !== null ? `同比 ${fmtPct(metric.yoy)}` : metric.period}
                tone={metric.yoy}
              />
            ))}
          </div>
          {fundamentals.highlights.length > 0 && (
            <ul className="small muted mt-2">
              {fundamentals.highlights.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {fundInfo && (
        <div className="mb-3">
          <div className="small strong mb-2">基金详情</div>
          <div className="grid-4 mb-2">
            <Metric label="基金名称" value={fundInfo.name || '—'} />
            <Metric label="基金类型" value={fundInfo.type || '—'} />
            <Metric label="基金经理" value={fundInfo.manager || '—'} />
            <Metric label="基金公司" value={fundInfo.company || '—'} />
            <Metric label="最新净值" value={fundInfo.nav ? fmtNum(fundInfo.nav, 4) : '—'} hint={fundInfo.navDate ? `净值日期 ${fundInfo.navDate}` : undefined} />
            <Metric label="累计净值" value={fundInfo.accumNav ? fmtNum(fundInfo.accumNav, 4) : '—'} />
            <Metric label="基金规模" value={fundInfo.scale ? `${fmtNum(fundInfo.scale, 2)} 亿` : '—'} />
            <Metric label="申购费率" value={fundInfo.feeRate ? fmtPct(fundInfo.feeRate, 2, false) : '—'} />
          </div>
          {fundInfo.returns.length > 0 && (
            <div className="grid-4 mb-2">
              {fundInfo.returns.map((item) => (
                <Metric key={item.label} label={item.label} value={fmtPct(item.value)} tone={item.value} />
              ))}
            </div>
          )}
          {fundInfo.allocation.length > 0 && (
            <div className="grid-4 mb-2">
              {fundInfo.allocation.map((item) => (
                <Metric key={item.label} label={item.label} value={fmtPct(item.value, 2, false)} />
              ))}
            </div>
          )}
          {fundInfo.holdings.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>重仓股</th>
                    <th>代码</th>
                    <th className="num">占净值比</th>
                  </tr>
                </thead>
                <tbody>
                  {fundInfo.holdings.slice(0, 10).map((holding) => (
                    <tr key={`${holding.code}-${holding.name}`}>
                      <td>{holding.name}</td>
                      <td className="mono tiny">{holding.code}</td>
                      <td className="num">{fmtPct(holding.weight, 2, false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div>
        <div className="small strong mb-2">分红情况</div>
        {dividends.length === 0 ? (
          <div className="mute small">暂无分红记录（或数据源未提供）</div>
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
                {dividends.slice(0, 12).map((item, index) => (
                  <tr key={`${item.period}-${index}`}>
                    <td>{item.period || '—'}</td>
                    <td>{item.plan || '—'}</td>
                    <td className="num">{item.cashPerShare ? fmtNum(item.cashPerShare, 4) : '—'}</td>
                    <td>{item.exDate ?? '—'}</td>
                    <td>{item.recordDate ?? '—'}</td>
                    <td>{item.payDate ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {profile.warnings.length > 0 && <div className="tiny mute mt-3">数据源提示：{profile.warnings.join('；')}</div>}
    </Card>
  );
}

function Metric(props: { label: string; value: string; hint?: string; tone?: number }) {
  const toneClass = props.tone === undefined ? '' : pnlClass(props.tone);
  return (
    <div className="panel">
      <div className="tiny mute">{props.label}</div>
      <div className={`strong ${toneClass}`} style={{ marginTop: 2 }}>
        {props.value}
      </div>
      {props.hint && <div className="tiny mute">{props.hint}</div>}
    </div>
  );
}

/** Convenience: convert transactions into chart markers. */
export function markersFromTransactions(
  transactions: { kind: string; tradeDate: string; price: number; shares: number }[],
): TradeMarker[] {
  return transactions
    .filter((tx) => safeNumber(tx.price) > 0)
    .map((tx) => ({
      kind: tx.kind === 'sell' ? 'sell' : 'buy',
      date: tx.tradeDate.slice(0, 10),
      price: safeNumber(tx.price),
      shares: safeNumber(tx.shares),
    }));
}
