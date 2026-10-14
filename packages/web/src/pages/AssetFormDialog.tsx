/**
 * 资产新增 / 编辑浮窗（含交易记录补录）。owner: web-core-pages
 *
 * 新增：代码 → 名称自动补全走 GET /api/market/search，失败静默降级（允许手工输入）。
 * 编辑：基本信息走 PUT，交易记录走 POST / DELETE，服务端会按移动加权平均法重算持仓。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssetDetail, InstrumentSearchResult, InstrumentType, Market, Transaction, TxKind } from '@aia/shared';
import { INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS, MARKETS, MARKET_LABELS } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync, useDebounced } from '../api/hooks';
import { fmtDate, fmtPrice, safeNumber, todayIso } from '../format';
import { Alert, Button, Card, ConfirmDialog, Dropdown, ErrorAlert, Field, Input, Loading, Modal, Textarea, useToast } from '../components/ui';
import { TransactionTable } from './AssetDetailDialog';

const CODE_PLACEHOLDER = '600519 / 00700 / AAPL';

/** 后端 NOT_CONFIGURED 时统一给出设置页引导。 */
function NotConfiguredHint() {
  return (
    <Alert tone="warn">
      尚未配置 LLM API Key，AI 相关功能不可用，请到 <Link to="/settings">设置页</Link> 填写 API Key。
    </Alert>
  );
}

/* ─────────────────────────────── 添加资产 ─────────────────────────────── */

export function AssetCreateDialog(props: { open: boolean; onClose: () => void; onCreated: (asset: AssetDetail) => void }) {
  const { open, onClose, onCreated } = props;
  const toast = useToast();
  const [type, setType] = useState<InstrumentType>('stock');
  const [market, setMarket] = useState<Market>('CN');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [shares, setShares] = useState('');
  const [price, setPrice] = useState('');
  const [fee, setFee] = useState('');
  const [tradeDate, setTradeDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  // 每次打开都回到干净的表单，避免上次输入残留造成误建仓。
  useEffect(() => {
    if (!open) return;
    setCode('');
    setName('');
    setShares('');
    setPrice('');
    setFee('');
    setNote('');
    setTradeDate(todayIso());
    setFormError(null);
    setNotConfigured(false);
  }, [open]);

  const term = useDebounced(code.trim(), 400);
  // 补全失败不应阻塞手工录入，因此把错误吞掉变成空列表。
  const search = useAsync<InstrumentSearchResult[]>(
    () => (open && term.length > 0 ? api.market.search(term, market).catch(() => []) : Promise.resolve([])),
    [open, term, market],
  );
  const suggestions = search.data ?? [];

  const pick = (item: InstrumentSearchResult) => {
    setCode(item.code);
    setName(item.name);
    setType(item.type);
    setMarket(item.market);
  };

  const submit = async () => {
    const sharesNum = safeNumber(shares);
    const priceNum = safeNumber(price);
    if (!code.trim()) return setFormError('请填写市场代码');
    if (sharesNum <= 0) return setFormError('买入份额必须大于 0');
    if (priceNum <= 0) return setFormError('买入单价必须大于 0');
    if (!tradeDate) return setFormError('请选择买入日期');

    setBusy(true);
    setFormError(null);
    setNotConfigured(false);
    try {
      const created = await api.assets.create({
        code: code.trim(),
        market,
        type,
        name: name.trim() || undefined,
        shares: sharesNum,
        price: priceNum,
        tradeDate,
        fee: safeNumber(fee) || undefined,
        note: note.trim() || undefined,
      });
      toast.success('资产已添加', `${created.name} · ${created.market}/${created.code}`);
      onCreated(created);
      onClose();
    } catch (error) {
      const err = toApiError(error);
      setFormError(err.message);
      setNotConfigured(err.isNotConfigured);
      toast.error('添加资产失败', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="添加资产"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            保存并建仓
          </Button>
        </>
      }
    >
      {formError && <Alert tone="error">{formError}</Alert>}
      {notConfigured && <NotConfiguredHint />}

      <div className="form-grid">
        <Field label="资产类型">
          <Dropdown
            value={type}
            ariaLabel="资产类型"
            onChange={(next) => setType(next as InstrumentType)}
            items={INSTRUMENT_TYPES.map((item) => ({ value: item, label: INSTRUMENT_TYPE_LABELS[item] }))}
          />
        </Field>
        <Field label="市场">
          <Dropdown
            value={market}
            ariaLabel="市场"
            onChange={(next) => setMarket(next as Market)}
            items={MARKETS.map((item) => ({ value: item, label: MARKET_LABELS[item] }))}
          />
        </Field>
        <Field label="市场代码" hint="输入代码后自动补全名称（可手工修改）" className="span-2">
          <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder={CODE_PLACEHOLDER} />
        </Field>
        <Field label="资产名称" hint="留空则由数据源自动补全" className="span-2">
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="选择下方补全结果或手动填写" />
        </Field>
        <Field label="买入份额">
          <Input type="number" min="0" step="any" value={shares} onChange={(event) => setShares(event.target.value)} placeholder="100" />
        </Field>
        <Field label="买入单价">
          <Input type="number" min="0" step="any" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="10.5" />
        </Field>
        <Field label="买入日期">
          <Input type="date" value={tradeDate} onChange={(event) => setTradeDate(event.target.value)} />
        </Field>
        <Field label="交易费用（可选）">
          <Input type="number" min="0" step="any" value={fee} onChange={(event) => setFee(event.target.value)} placeholder="0" />
        </Field>
        <Field label="备注" className="span-2">
          <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="例如：定投 / 分批建仓" />
        </Field>
      </div>

      {term.length > 0 && (
        <div>
          <div className="tiny mute mb-1">
            行情代码补全 {search.loading ? '（检索中…）' : suggestions.length === 0 ? '（无匹配，可直接手工填写）' : ''}
          </div>
          <div className="flex wrap gap-2">
            {suggestions.slice(0, 8).map((item) => (
              <Button key={`${item.market}-${item.code}`} size="sm" variant="ghost" onClick={() => pick(item)} title={`${item.exchange} · ${INSTRUMENT_TYPE_LABELS[item.type]}`}>
                {item.name} <span className="mono tiny mute">{item.code}</span>
              </Button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─────────────────────────────── 编辑资产 ─────────────────────────────── */

export function AssetEditDialog(props: { assetId: string | null; open: boolean; onClose: () => void; onMutated?: () => void }) {
  const { assetId, open, onClose, onMutated } = props;
  const toast = useToast();

  const state = useAsync<AssetDetail | null>(
    () => (open && assetId ? api.assets.get(assetId) : Promise.resolve(null)),
    [assetId, open],
  );
  const detail = open && assetId ? state.data : null;

  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [market, setMarket] = useState<Market>('CN');
  const [type, setType] = useState<InstrumentType>('stock');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  // 详情（首次加载或写操作后 reload）落地时同步表单。
  useEffect(() => {
    if (!open || !detail) return;
    setName(detail.name);
    setNote(detail.note);
    setMarket(detail.market);
    setType(detail.type);
  }, [open, detail]);

  const [txKind, setTxKind] = useState<TxKind>('buy');
  const [txShares, setTxShares] = useState('');
  const [txPrice, setTxPrice] = useState('');
  const [txDate, setTxDate] = useState(todayIso());
  const [txFee, setTxFee] = useState('');
  const [txNote, setTxNote] = useState('');
  const [addingTx, setAddingTx] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const [pendingTx, setPendingTx] = useState<Transaction | null>(null);
  const [removingTx, setRemovingTx] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTxShares('');
    setTxPrice('');
    setTxFee('');
    setTxNote('');
    setTxDate(todayIso());
    setTxKind('buy');
    setTxError(null);
  }, [open]);

  const applyError = (error: unknown, title: string, setter: (message: string) => void) => {
    const err = toApiError(error);
    setter(err.message);
    setNotConfigured(err.isNotConfigured);
    toast.error(title, err.message);
  };

  const saveBasic = async () => {
    if (!detail) return;
    if (!name.trim()) return setFormError('资产名称不能为空');
    setSaving(true);
    setFormError(null);
    try {
      const updated = await api.assets.update(detail.id, { name: name.trim(), note: note.trim(), market, type });
      toast.success('已保存资产信息', updated.name);
      state.reload();
      onMutated?.();
    } catch (error) {
      applyError(error, '保存失败', setFormError);
    } finally {
      setSaving(false);
    }
  };

  const addTransaction = async () => {
    if (!detail) return;
    const sharesNum = safeNumber(txShares);
    const priceNum = safeNumber(txPrice);
    if (sharesNum <= 0) return setTxError('份额必须大于 0');
    if (priceNum <= 0) return setTxError('单价必须大于 0');
    if (!txDate) return setTxError('请选择交易日期');

    setAddingTx(true);
    setTxError(null);
    try {
      await api.assets.addTransaction(detail.id, {
        kind: txKind,
        shares: sharesNum,
        price: priceNum,
        tradeDate: txDate,
        fee: safeNumber(txFee) || undefined,
        note: txNote.trim() || undefined,
        source: 'manual',
      });
      toast.success(txKind === 'buy' ? '已补录买入记录' : '已补录卖出记录');
      setTxShares('');
      setTxPrice('');
      setTxFee('');
      setTxNote('');
      state.reload();
      onMutated?.();
    } catch (error) {
      applyError(error, '补录交易失败', setTxError);
    } finally {
      setAddingTx(false);
    }
  };

  const confirmRemoveTx = async () => {
    if (!detail || !pendingTx) return;
    setRemovingTx(true);
    try {
      await api.assets.removeTransaction(detail.id, pendingTx.id);
      toast.success('交易记录已删除', '持仓与成本已重新计算');
      setPendingTx(null);
      state.reload();
      onMutated?.();
    } catch (error) {
      applyError(error, '删除交易记录失败', setTxError);
    } finally {
      setRemovingTx(false);
    }
  };

  return (
    <Modal
      open={open}
      size="md"
      title={detail ? `编辑 · ${detail.name}` : '编辑资产'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving || addingTx}>
            关闭
          </Button>
          <Button variant="primary" onClick={saveBasic} loading={saving} disabled={!detail}>
            保存基本信息
          </Button>
        </>
      }
    >
      {state.loading && !detail && <Loading label="正在读取资产详情…" />}
      {state.error && <ErrorAlert error={state.error} onRetry={state.reload} />}
      {notConfigured && <NotConfiguredHint />}

      {detail && (
        <>
          <Card title="基本信息">
            {formError && <Alert tone="error">{formError}</Alert>}
            <div className="form-grid">
              <Field label="资产名称" className="span-2">
                <Input value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field label="市场">
                <Dropdown
                  value={market}
                  ariaLabel="市场"
                  onChange={(next) => setMarket(next as Market)}
                  items={MARKETS.map((item) => ({ value: item, label: MARKET_LABELS[item] }))}
                />
              </Field>
              <Field label="资产类型">
                <Dropdown
                  value={type}
                  ariaLabel="资产类型"
                  onChange={(next) => setType(next as InstrumentType)}
                  items={INSTRUMENT_TYPES.map((item) => ({ value: item, label: INSTRUMENT_TYPE_LABELS[item] }))}
                />
              </Field>
              <Field label="用户备注" className="span-2">
                <Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="持仓逻辑、止损位、买入理由…" />
              </Field>
            </div>
            <div className="tiny mute mt-2">
              当前持仓：{fmtPrice(detail.price, detail.currency)} · {detail.code} · {fmtDate(detail.firstBuyAt)} 建仓
            </div>
          </Card>

          <Card title="手动补录交易记录" actions={<span className="tiny mute">按移动加权平均法重算成本</span>}>
            {txError && <Alert tone="error">{txError}</Alert>}
            <div className="form-grid">
              <Field label="方向">
                <Dropdown
                  value={txKind}
                  ariaLabel="交易方向"
                  onChange={(next) => setTxKind(next as TxKind)}
                  items={[
                    { value: 'buy', label: '买入' },
                    { value: 'sell', label: '卖出' },
                  ]}
                />
              </Field>
              <Field label="交易日期">
                <Input type="date" value={txDate} onChange={(event) => setTxDate(event.target.value)} />
              </Field>
              <Field label="份额">
                <Input type="number" min="0" step="any" value={txShares} onChange={(event) => setTxShares(event.target.value)} />
              </Field>
              <Field label="单价">
                <Input type="number" min="0" step="any" value={txPrice} onChange={(event) => setTxPrice(event.target.value)} />
              </Field>
              <Field label="费用（可选）">
                <Input type="number" min="0" step="any" value={txFee} onChange={(event) => setTxFee(event.target.value)} />
              </Field>
              <Field label="备注">
                <Input value={txNote} onChange={(event) => setTxNote(event.target.value)} />
              </Field>
            </div>
            <div className="right mt-3">
              <Button variant="primary" size="sm" onClick={addTransaction} loading={addingTx}>
                写入交易
              </Button>
            </div>
          </Card>

          <Card title={`交易记录（${detail.transactions.length} 笔）`}>
            <TransactionTable transactions={detail.transactions} currency={detail.currency} onDelete={setPendingTx} />
          </Card>
        </>
      )}

      <ConfirmDialog
        open={pendingTx !== null}
        danger
        busy={removingTx}
        title="删除这笔交易？"
        confirmLabel="删除"
        message={pendingTx ? `${fmtDate(pendingTx.tradeDate)} ${pendingTx.kind === 'buy' ? '买入' : '卖出'}` : ''}
        onConfirm={confirmRemoveTx}
        onCancel={() => setPendingTx(null)}
      />
    </Modal>
  );
}
