/**
 * IpoDetailDialog — 单只新股的详情浮窗。Owner: web-ai-pages.
 *
 * 三段：
 *   ① 发行要素（上游给什么显示什么，缺失一律显示「未提供」而不是 0）；
 *   ② AI 打新建议（Markdown 全文 + verdict / 建议股数 / 胜率 / 预期收益 / 期望值 / 优质分 / 置信度）；
 *   ③ 我的打新登记 —— 申购登记 → 中签登记（自动入账）→ 修正，构成的完整闭环。
 *
 * `focusRegister`：从「AI 投资建议」页的「登记」按钮打开时，直接滚到第 ③ 段，
 * 用户点一下就能填股数（同一套弹窗与校验，不再造第二个表单）。
 */
import { useEffect, useRef, useState } from 'react';
import { IPO_STATUS_LABELS, MARKET_CURRENCY } from '@aia/shared';
import type { IpoOffer } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync } from '../api/hooks';
import { fmtCompact, fmtDate, fmtDateTime, fmtNum, fmtPrice, todayIso } from '../format';
import {
  Alert,
  Badge,
  Button,
  ErrorAlert,
  Field,
  Input,
  KV,
  Loading,
  MarketTag,
  Modal,
  StatCard,
  Textarea,
  useToast,
} from '../components/ui';
import { Markdown } from '../components/markdown/Markdown';
import {
  IPO_VERDICT_HINT,
  IPO_VERDICT_TONE,
  expectedReturnValue,
  expectedValueValue,
  priceText,
  verdictLabel,
  verdictReasonText,
  winRateValue,
} from './ipoView';

/** 缺失值统一显示成「未提供」——上游没有的字段绝不用 0 冒充。 */
function orDash(value: string | number | null | undefined, format?: (input: number) => string): string {
  if (value === null || value === undefined || value === '') return '未提供';
  if (typeof value === 'number') {
    if (value === 0) return '未提供';
    return format ? format(value) : String(value);
  }
  return value;
}

export function IpoDetailDialog(props: {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
  /** 打开后直接滚到「我的打新登记」（AI 投资建议页的登记入口用）。 */
  focusRegister?: boolean;
}) {
  const { id, onClose } = props;
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  const detail = useAsync(() => (id ? api.ipo.get(id) : Promise.resolve(null)), [id, nonce]);
  const registerRef = useRef<HTMLElement | null>(null);

  const [subShares, setSubShares] = useState('');
  const [subPrice, setSubPrice] = useState('');
  const [subDate, setSubDate] = useState('');
  const [subNote, setSubNote] = useState('');
  const [subBusy, setSubBusy] = useState(false);

  const [allotShares, setAllotShares] = useState('');
  const [allotPrice, setAllotPrice] = useState('');
  const [allotFee, setAllotFee] = useState('');
  const [allotDate, setAllotDate] = useState('');
  const [allotNote, setAllotNote] = useState('');
  const [allotBusy, setAllotBusy] = useState(false);

  const offer = detail.data;
  const subscription = offer?.subscription ?? null;

  // 打开/切换标的时，按「AI 建议股数 → 申购上限 → 每手股数」预填申购股数，
  // 让「AI 建议 3 手」这类结论一键可登记。
  useEffect(() => {
    if (!offer) return;
    const preset = offer.suggestedShares > 0 ? offer.suggestedShares : offer.maxShares > 0 ? offer.maxShares : offer.lotSize;
    setSubShares(preset > 0 ? String(preset) : '');
    setSubPrice(offer.issuePrice > 0 ? String(offer.issuePrice) : '');
    setSubDate(todayIso());
    setSubNote('');
    setAllotShares(subscription?.allottedShares ? String(subscription.allottedShares) : '');
    setAllotPrice(String(subscription?.price || offer.issuePrice || ''));
    setAllotFee('');
    setAllotDate(todayIso());
    setAllotNote('');
    // 只在标的本身变化时重置表单，避免刷新详情时清掉用户正在输入的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offer?.id]);

  function reload(): void {
    setNonce((value) => value + 1);
    props.onChanged();
  }

  // 从建议页点「登记」进来时，把视图直接带到登记表单（加载完成后才有 DOM）。
  // 只依赖标的 id：详情刷新（reload）不该把用户正在填的表单来回滚动。
  useEffect(() => {
    if (!props.focusRegister || !offer?.id) return;
    registerRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusRegister, offer?.id]);

  async function submitSubscription(): Promise<void> {
    if (!id) return;
    const shares = Number(subShares);
    if (!(shares > 0)) {
      toast.error('申购股数无效', '请填写大于 0 的申购股数');
      return;
    }
    setSubBusy(true);
    try {
      await api.ipo.subscribe(id, {
        shares,
        price: Number(subPrice) > 0 ? Number(subPrice) : undefined,
        appliedAt: subDate || undefined,
        note: subNote.trim() || undefined,
      });
      toast.success('已登记申购', `${offer?.name ?? ''} ${shares} 股；中签后回来登记中签结果即可自动入账`);
      reload();
    } catch (error) {
      toast.error('登记申购失败', toApiError(error).message);
    } finally {
      setSubBusy(false);
    }
  }

  async function submitAllotment(): Promise<void> {
    if (!id) return;
    const shares = Number(allotShares || 0);
    if (shares < 0 || Number.isNaN(shares)) {
      toast.error('中签股数无效', '未中签请填 0');
      return;
    }
    setAllotBusy(true);
    try {
      const result = await api.ipo.allot(id, {
        shares,
        price: Number(allotPrice) > 0 ? Number(allotPrice) : undefined,
        fee: Number(allotFee) > 0 ? Number(allotFee) : undefined,
        tradeDate: allotDate || undefined,
        note: allotNote.trim() || undefined,
      });
      if (shares === 0) {
        toast.success('已登记未中签', `${result.offer.name}：本次未中签，未写入账本`);
      } else {
        toast.success(
          result.assetCreated ? '已中签入账（新建资产）' : '已中签入账',
          `${result.offer.name} ${shares} 股已写入「我的资产」${result.asset ? `（${result.asset.name}）` : ''}`,
        );
      }
      if (result.warnings.length > 0) toast.info('入账提示', result.warnings.join('；'));
      reload();
    } catch (error) {
      toast.error('中签登记失败', toApiError(error).message);
    } finally {
      setAllotBusy(false);
    }
  }

  async function removeSubscription(): Promise<void> {
    if (!id) return;
    try {
      await api.ipo.unsubscribe(id);
      toast.success('已撤销申购登记', '该登记没有产生账本记录，已直接删除');
      reload();
    } catch (error) {
      toast.error('撤销失败', toApiError(error).message);
    }
  }

  const alreadyAllotted = subscription?.status === 'allotted';
  const missed = subscription?.status === 'missed';

  return (
    <Modal
      open={id !== null}
      title={
        <span className="center gap-2">
          {offer ? `${offer.name} ${offer.code}` : '打新详情'}
          {offer && <MarketTag market={offer.market} />}
          {offer && <Badge>{IPO_STATUS_LABELS[offer.status] ?? offer.status}</Badge>}
          {offer?.verdict && (
            <Badge tone={IPO_VERDICT_TONE[offer.verdict]} title={IPO_VERDICT_HINT[offer.verdict]}>
              {verdictLabel(offer.verdict)}
            </Badge>
          )}
        </span>
      }
      onClose={onClose}
      size="lg"
    >
      <ErrorAlert error={detail.error} onRetry={detail.reload} />
      {detail.loading && !offer && <Loading label="正在读取新股详情…" />}

      {offer && (
        <div className="flex" style={{ flexDirection: 'column', gap: 16 }}>
          {/* ① 发行要素 */}
          <section>
            <div className="section-title">发行要素</div>
            <KV
              items={[
                ['上市代码', offer.code || '未确定'],
                ['申购代码', offer.subscribeCode || '—'],
                ['交易所 / 板块', `${offer.exchange || '未提供'} / ${offer.board || '未提供'}`],
                ['发行价', priceText(offer)],
                ['每手股数', orDash(offer.lotSize, (value) => `${fmtNum(value, 0)} 股`)],
                ['申购上限', orDash(offer.maxShares, (value) => `${fmtNum(value, 0)} 股`)],
                ['申购开始', offer.subscribeStart || '未提供'],
                ['申购截止', offer.subscribeEnd || '未提供'],
                ['中签 / 定价日', offer.allotmentDate || '未提供'],
                ['上市日', offer.listingDate || '未提供'],
                ['发行总量', orDash(offer.issueShares, (value) => `${fmtCompact(value)} 股`)],
                [
                  '募资额',
                  orDash(offer.raiseAmount, (value) => fmtPrice(value, offer.currency || MARKET_CURRENCY[offer.market])),
                ],
                ['发行市盈率 / 行业', offer.issuePe > 0 || offer.industryPe > 0 ? `${fmtNum(offer.issuePe)} / ${fmtNum(offer.industryPe)}` : '未提供'],
                ['中签率', orDash(offer.winningRate, (value) => `${fmtNum(value, 2)}%`)],
                ['超额认购', orDash(offer.oversubscribe, (value) => `${fmtNum(value, 1)} 倍`)],
                ['保荐 / 承销', offer.sponsor || '未提供'],
                ['行业', offer.industry || '未提供'],
                ['数据来源', offer.source],
                ['最近更新', fmtDateTime(offer.updatedAt)],
              ]}
            />
            {offer.prospectusUrl && (
              <div className="tiny mt-2">
                招股书 / 上市公告：
                <a href={offer.prospectusUrl} target="_blank" rel="noreferrer noopener">
                  {offer.prospectusUrl}
                </a>
              </div>
            )}
            {offer.note && <div className="tiny mute mt-2">备注：{offer.note}</div>}
          </section>

          {/* ② AI 打新建议 */}
          <section>
            <div className="section-title">
              AI 打新建议
              {offer.adviceAt && <span className="tiny mute">（{fmtDateTime(offer.adviceAt)}）</span>}
            </div>
            {offer.advice ? (
              <>
                <div className="toolbar mb-2">
                  <Badge tone={offer.verdict ? IPO_VERDICT_TONE[offer.verdict] : 'default'} title={offer.verdict ? IPO_VERDICT_HINT[offer.verdict] : undefined}>
                    {offer.verdict ? verdictLabel(offer.verdict) : '未判定'}
                  </Badge>
                  <span className="tiny">
                    建议申购 <b>{fmtNum(offer.suggestedShares, 0)}</b> 股 · 优质分 <b>{fmtNum(offer.qualityScore, 0)}</b> ·
                    置信度 <b>{fmtNum(offer.confidence * 100, 0)}%</b>
                  </span>
                </div>
                {/* 一句话理由：这是「为什么是这个结论」的答案。高胜率却本期不申购时，缺口就写在这里。 */}
                {verdictReasonText(offer) && (
                  <div className="mb-2" style={{ lineHeight: 1.6 }}>
                    <span className="tiny mute">推荐理由：</span>
                    <b className="tiny">{verdictReasonText(offer)}</b>
                  </div>
                )}
                {/* 用户最关心的两个数：胜率（买不买得到之后赚不赚）与预期收益，必须一眼可见。 */}
                <div className="grid-3 mb-2">
                  <StatCard label="胜率（AI 推算）" value={winRateValue(offer)} sub="上市后正收益的概率" />
                  <StatCard label="预期收益（AI 推算）" value={expectedReturnValue(offer)} sub="相对发行价的涨幅，可为负" />
                  <StatCard label="期望值" value={expectedValueValue(offer)} sub="胜率 × 预期收益（按打中一手算）" />
                </div>
                {/* 老结论（2026-10 之前写入的）没有胜率/预期收益：如实提示怎么补齐，而不是显示 0。 */}
                {offer.winProbability <= 0 && (
                  <div className="mb-2">
                    <Alert tone="warn">
                      这条结论是旧版本写入的，没有胜率与预期收益。重跑一次「AI 打新分析」即会按新要求补齐这两个数。
                    </Alert>
                  </div>
                )}
                <div className="tiny mute mb-2">
                  中签率（上游公告，回答「能不能买到」）：
                  {offer.winningRate > 0 ? ` ${fmtNum(offer.winningRate, 2)}%` : ' 未提供'}
                  {offer.oversubscribe > 0 ? ` · 超额认购 ${fmtNum(offer.oversubscribe, 1)} 倍` : ''}
                  。胜率与预期收益是 AI 依据中签率/超购、可比估值折价、市场情绪与破发案例做的推算，不是承诺。
                  <br />
                  口径：<b>胜率 / 预期收益</b>回答「上市后涨不涨」，而<b>结论</b>回答「本期该不该打」——
                  后者还把本月预算与一手入场费算进去了，所以「胜率高但本期不申购」通常是因为预算不够，不是看空。
                </div>
                <Markdown text={offer.advice} />
              </>
            ) : (
              <Alert tone="info">
                还没有 AI 打新建议。点击页面上的「AI 打新分析」让 Agent 结合发行定价、招股书、财报、宏观与国际局势给出结论。
              </Alert>
            )}
          </section>

          {/* ③ 我的打新登记（建议页「登记」按钮会直接滚到这里） */}
          <section ref={registerRef}>
            <div className="section-title">我的打新登记</div>
            {subscription ? (
              <div className="flex" style={{ flexDirection: 'column', gap: 10 }}>
                <KV
                  items={[
                    ['状态', alreadyAllotted ? '已中签（已入账）' : missed ? '未中签' : '已登记申购'],
                    ['申购股数', `${fmtNum(subscription.appliedShares, 0)} 股`],
                    ['中签股数', `${fmtNum(subscription.allottedShares, 0)} 股`],
                    ['缴款单价', orDash(subscription.price, (value) => fmtPrice(value, subscription.currency))],
                    ['手续费', subscription.fee > 0 ? fmtPrice(subscription.fee, subscription.currency) : '无'],
                    ['申购日', subscription.appliedAt],
                    ['中签 / 入账日', subscription.allottedAt || '未提供'],
                    ['入账资产', subscription.assetId ? `已入账（${subscription.assetId.slice(0, 8)}…）` : '未入账'],
                  ]}
                />
                {subscription.note && <div className="tiny mute">备注：{subscription.note}</div>}
                {alreadyAllotted && (
                  <Alert tone="info">
                    已按中签结果入账。若券商最终确认的股数/价格与登记不一致，可在下方重新提交（系统会先撤销上一次由打新写入的流水再重写；
                    已有后续卖出时会拒绝，请改在「我的资产」里手动修正）。
                  </Alert>
                )}
              </div>
            ) : (
              <Alert tone="info">
                还没有登记。{" "}
                {offer.status === 'listed'
                  ? '该新股已上市，无法再登记申购；成交可直接在「我的资产」补录。'
                  : '填写实际申购股数后点「登记申购」；这只是记账，中签前不会写入资产。'}
              </Alert>
            )}

            {offer.status !== 'listed' && (
              <div className="form-grid mt-2">
                <Field label="申购股数" hint={offer.lotSize > 0 ? `每手 ${offer.lotSize} 股` : undefined}>
                  <Input value={subShares} inputMode="numeric" onChange={(event) => setSubShares(event.target.value)} />
                </Field>
                <Field label="申购价" hint="默认取发行价">
                  <Input value={subPrice} inputMode="decimal" onChange={(event) => setSubPrice(event.target.value)} />
                </Field>
                <Field label="申购日期">
                  <Input type="date" value={subDate} onChange={(event) => setSubDate(event.target.value)} />
                </Field>
                <Field label="备注">
                  <Input value={subNote} onChange={(event) => setSubNote(event.target.value)} placeholder="可选，例如「券商 App 已冻结资金」" />
                </Field>
                <div className="row-actions" style={{ alignSelf: 'end' }}>
                  <Button variant="primary" loading={subBusy} onClick={() => void submitSubscription()}>
                    {subscription ? '更新申购登记' : '登记申购'}
                  </Button>
                  {subscription && !subscription.assetId && (
                    <Button variant="ghost" onClick={() => void removeSubscription()}>
                      撤销登记
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* 中签登记：未中签填 0，中签填实际股数并自动入账。 */}
            <div className="mt-2">
              <div className="section-title">登记中签结果（自动入账）</div>
              <div className="form-grid">
                <Field label="中签股数" hint="未中签填 0">
                  <Input value={allotShares} inputMode="numeric" onChange={(event) => setAllotShares(event.target.value)} />
                </Field>
                <Field label="缴款单价" hint={offer.issuePrice > 0 ? `发行价 ${offer.issuePrice}` : '尚未定价，需手填'}>
                  <Input value={allotPrice} inputMode="decimal" onChange={(event) => setAllotPrice(event.target.value)} />
                </Field>
                <Field label="手续费 / 认购费">
                  <Input value={allotFee} inputMode="decimal" onChange={(event) => setAllotFee(event.target.value)} />
                </Field>
                <Field label="入账日期">
                  <Input type="date" value={allotDate} onChange={(event) => setAllotDate(event.target.value)} />
                </Field>
                <Field label="备注">
                  <Textarea rows={2} value={allotNote} onChange={(event) => setAllotNote(event.target.value)} />
                </Field>
                <div className="row-actions" style={{ alignSelf: 'end' }}>
                  <Button variant="primary" loading={allotBusy} onClick={() => void submitAllotment()}>
                    登记中签并写入资产
                  </Button>
                </div>
              </div>
              <div className="tiny mute mt-2">
                中签股数 &gt; 0 时，系统会按「中签价 × 股数 + 费用」在「我的资产」里建立/复用该标的的持仓与一笔
                <b> IPO 买入流水</b>；打新缴款是已发生的真实支出，因此不受月度预算拦截（超出预算只在提示里说明）。
                中签号公布日：{fmtDate(offer.allotmentDate)}。
              </div>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}