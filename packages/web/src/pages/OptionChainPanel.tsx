/**
 * 期权链 / 候选合约面板（纯展示）— owner: web-options.
 *
 * 用户最担心的是「这价格准不准」，所以数据口径（来源 · 抓取时间 · 是否延迟）
 * 排在所有数字之前，且每条警告原样展示。港股期权链来自 HKEX 每日收市报告，
 * 美股默认是 CBOE 延迟行情 —— 这一点必须写在页面上，而不是藏在提示里。
 */
import { OPTION_SOURCE_LABELS, OPTION_STRATEGY_LABELS, OPTION_TYPE_LABELS } from '@aia/shared';
import type { OptionCandidatesResponse, OptionChainSnapshot, OptionMarket, OptionQuote } from '@aia/shared';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtPct, fmtPrice } from '../format';
import { Alert, Badge, Card, Empty, MarketTag } from '../components/ui';
import { OPTION_STRATEGY_TONE, assignmentProbabilityText, liquidityText, optionCollateralText } from './optionView';

export function sourceLabel(source: string): string {
  return OPTION_SOURCE_LABELS[source] ?? source ?? '未知来源';
}

/** 价格来源与延迟口径（醒目放在数字之前）。 */
export function OptionDataProvenance(props: {
  market: OptionMarket;
  code: string;
  name?: string;
  currency: string;
  underlyingPrice: number;
  source: string;
  asOf: string;
  delayed: boolean;
}) {
  return (
    <div className="option-provenance">
      <div className="center gap-2 wrap">
        <MarketTag market={props.market} />
        <span className="strong">{props.name || props.code}</span>
        <span className="mono tiny mute">{props.code}</span>
        <span className="tiny">标的现价 {fmtPrice(props.underlyingPrice, props.currency)}</span>
        <Badge tone={props.delayed ? 'warn' : 'ok'} title={props.delayed ? '这条链是延迟/收盘口径，不能当成实时价' : '实时口径'}>
          {props.delayed ? '延迟 / 收盘口径（非实时）' : '实时口径'}
        </Badge>
      </div>
      <div className="tiny mute mt-1">
        价格来源：<b>{sourceLabel(props.source)}</b> · 抓取时间 {fmtDateTime(props.asOf)}
        {props.delayed
          ? ' · 延迟行情到期结算仍按到期日收盘价判定，盘中的权利金只能作为参考'
          : ''}
      </div>
    </div>
  );
}

function quoteRow(quote: OptionQuote, currency: string) {
  return (
    <tr key={quote.code}>
      <td className="mono tiny">{quote.code}</td>
      <td>
        <Badge tone={quote.type === 'call' ? 'sell' : 'buy'}>{OPTION_TYPE_LABELS[quote.type]}</Badge>
      </td>
      <td className="num mono">{fmtPrice(quote.strike, currency)}</td>
      <td className="tiny mono nowrap">{fmtDate(quote.expiry)}</td>
      <td className="num mono tiny">{fmtPrice(quote.bid, currency)}</td>
      <td className="num mono tiny">{fmtPrice(quote.ask, currency)}</td>
      <td className="num mono tiny">{fmtPrice(quote.mid, currency)}</td>
      <td className="num tiny">{quote.spreadPct > 0 ? fmtPct(quote.spreadPct, 1, false) : '—'}</td>
      <td className="num tiny">{fmtNum(quote.multiplier, 0)}</td>
      <td className="num tiny">{quote.iv > 0 ? fmtPct(quote.iv * 100, 1, false) : '上游未给'}</td>
      <td className="num tiny">{quote.delta !== 0 ? fmtNum(quote.delta, 3) : '—'}</td>
      <td className="num tiny">{fmtNum(quote.openInterest, 0)}</td>
      <td className="num tiny">{fmtNum(quote.volume, 0)}</td>
    </tr>
  );
}

/** 期权链快照：每个到期日的合约、隐含波动率与买卖价差（流动性）。 */
export function OptionChainPanel(props: { snapshot: OptionChainSnapshot; maxQuotes?: number }) {
  const { snapshot } = props;
  const quotes = snapshot.quotes.slice(0, props.maxQuotes ?? 150);
  return (
    <Card
      title={
        <span className="center gap-2">
          期权链快照
          <Badge>{snapshot.quotes.length} 条合约</Badge>
        </span>
      }
    >
      <OptionDataProvenance
        market={snapshot.market}
        code={snapshot.code}
        name={snapshot.name}
        currency={snapshot.currency}
        underlyingPrice={snapshot.underlyingPrice}
        source={snapshot.source}
        asOf={snapshot.asOf}
        delayed={snapshot.delayed}
      />

      {snapshot.warnings.length > 0 && (
        <div className="mt-2">
          <Alert tone="warn">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {snapshot.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      {snapshot.expiries.length === 0 ? (
        <Empty title="这个标的当前没有可用的期权链" hint="可能上游未提供该标的的期权，或该标的没有挂牌期权。" />
      ) : (
        <>
          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead>
                <tr>
                  <th>到期日</th>
                  <th className="num">剩余天数</th>
                  <th className="num">合约数</th>
                  <th className="num">平值 IV</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.expiries.map((group) => (
                  <tr key={group.expiry}>
                    <td className="mono tiny">{group.expiry}</td>
                    <td className="num tiny">{fmtNum(group.daysToExpiry, 0)}</td>
                    <td className="num tiny">{fmtNum(group.contracts, 0)}</td>
                    <td className="num tiny">{group.atmIv > 0 ? fmtPct(group.atmIv * 100, 1, false) : '上游未给'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-wrap mt-3">
            <table className="data-table">
              <thead>
                <tr>
                  <th>合约</th>
                  <th>方向</th>
                  <th className="num">行权价</th>
                  <th>到期</th>
                  <th className="num">买价</th>
                  <th className="num">卖价</th>
                  <th className="num">中间价</th>
                  <th className="num">价差%</th>
                  <th className="num">乘数</th>
                  <th className="num">IV</th>
                  <th className="num">delta</th>
                  <th className="num">未平仓</th>
                  <th className="num">成交量</th>
                </tr>
              </thead>
              <tbody>{quotes.map((quote) => quoteRow(quote, snapshot.currency))}</tbody>
            </table>
          </div>
          <div className="tiny mute mt-2">
            共 {snapshot.quotes.length} 条，此处显示前 {quotes.length} 条。买卖价差为「占中间价百分比」——
            价差越大，按中间价估算的权利金越容易高估；未平仓与成交量决定能不能真的成交。
          </div>
        </>
      )}
    </Card>
  );
}

/** 确定性筛选出的卖权候选（不经过 LLM，数字可复算）。 */
export function OptionCandidatePanel(props: { data: OptionCandidatesResponse }) {
  const { data } = props;
  return (
    <Card
      title={
        <span className="center gap-2">
          卖权候选（确定性筛选）
          <Badge>{data.candidates.length} 个</Badge>
        </span>
      }
    >
      <OptionDataProvenance
        market={data.market}
        code={data.code}
        currency={data.currency}
        underlyingPrice={data.underlyingPrice}
        source={data.source}
        asOf={data.asOf}
        delayed={data.delayed}
      />

      {data.warnings.length > 0 && (
        <div className="mt-2">
          <Alert tone="warn">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      {data.candidates.length === 0 ? (
        <Empty
          title="没有通过安全门槛的候选合约"
          hint="服务端按剩余期限、|delta|、未平仓、价差与最低年化收益率筛选；被挡掉的合约与原因见下方。"
        />
      ) : (
        <div className="grid-2 mt-3">
          {data.candidates.map((candidate) => {
            const quote = candidate.quote;
            const metrics = candidate.metrics;
            return (
              <div className="panel option-candidate" key={quote.code}>
                <div className="between wrap gap-2">
                  <span className="center gap-2">
                    <Badge tone={OPTION_STRATEGY_TONE[candidate.strategy]}>{OPTION_STRATEGY_LABELS[candidate.strategy]}</Badge>
                    <Badge tone={quote.type === 'call' ? 'sell' : 'buy'}>{OPTION_TYPE_LABELS[quote.type]}</Badge>
                    <span className="mono tiny">{quote.code}</span>
                  </span>
                  <span className="tiny mute nowrap">
                    年化 {fmtPct(metrics.annualizedYieldPct, 1, false)} · 静态 {fmtPct(metrics.staticYieldPct, 1, false)}
                  </span>
                </div>
                <div className="tiny muted mt-1">
                  行权价 {fmtPrice(quote.strike, data.currency)} · 到期 {fmtDate(quote.expiry)} · {fmtNum(quote.multiplier, 0)} 股/张 ·
                  中间价 {fmtPrice(quote.mid, data.currency)}
                </div>
                <div className="tiny mute mt-1">
                  每张权利金 {fmtMoney(metrics.premiumIncome, data.currency)}（未扣费用）· 安全垫{' '}
                  {fmtPct(metrics.downsideProtectionPct, 2, false)} · {assignmentProbabilityText(metrics.assignmentProbability, data.market)} ·{' '}
                  {optionCollateralText({ metrics, currency: data.currency })}
                </div>
                <div className="tiny mute mt-1">
                  {liquidityText(metrics.liquidityScore)} · 价差 {quote.spreadPct > 0 ? fmtPct(quote.spreadPct, 1, false) : '—'} · 未平仓{' '}
                  {fmtNum(quote.openInterest, 0)} · 成交量 {fmtNum(quote.volume, 0)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {data.rejected.length > 0 && (
        <div className="tiny mute mt-3">
          被安全门槛挡掉 {data.rejected.length} 个合约：
          <ul style={{ margin: '4px 0 0 16px' }}>
            {data.rejected.slice(0, 12).map((entry) => (
              <li key={entry.code}>
                <span className="mono">{entry.code}</span> — {entry.reason}
              </li>
            ))}
          </ul>
          {data.rejected.length > 12 ? `（仅列出前 12 条）` : ''}
        </div>
      )}
    </Card>
  );
}