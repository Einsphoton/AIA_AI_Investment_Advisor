/**
 * IpoAddDialog — 手动录入一只新股。Owner: web-ai-pages.
 *
 * 上游（美股小盘 / 港股 GEM）偶尔缺招股信息，或用户在券商 App 看到更准的发行价与申购日，
 * 这时允许人工录入（`source='manual'`）；刷新时上游数据仍会修正发行价与上市日。
 */
import { useState } from 'react';
import { MARKETS, MARKET_LABELS } from '@aia/shared';
import type { Market } from '@aia/shared';
import { api } from '../api/client';
import { toApiError } from '../api/hooks';
import { Button, Field, Input, Modal, Segmented, Textarea, useToast } from '../components/ui';

export function IpoAddDialog(props: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { open, onClose } = props;
  const toast = useToast();
  const [market, setMarket] = useState<Market>('CN');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [subscribeCode, setSubscribeCode] = useState('');
  const [issuePrice, setIssuePrice] = useState('');
  const [priceLow, setPriceLow] = useState('');
  const [priceHigh, setPriceHigh] = useState('');
  const [lotSize, setLotSize] = useState('');
  const [maxShares, setMaxShares] = useState('');
  const [subscribeStart, setSubscribeStart] = useState('');
  const [subscribeEnd, setSubscribeEnd] = useState('');
  const [allotmentDate, setAllotmentDate] = useState('');
  const [listingDate, setListingDate] = useState('');
  const [sponsor, setSponsor] = useState('');
  const [industry, setIndustry] = useState('');
  const [prospectusUrl, setProspectusUrl] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const num = (value: string): number | undefined => (Number(value) > 0 ? Number(value) : undefined);

  async function submit(): Promise<void> {
    if (!code.trim() || !name.trim()) {
      toast.error('请填写代码与名称', '代码是刷新与入账时的稳定业务键，不能为空');
      return;
    }
    setBusy(true);
    try {
      await api.ipo.create({
        market,
        code: code.trim(),
        name: name.trim(),
        subscribeCode: subscribeCode.trim() || undefined,
        issuePrice: num(issuePrice),
        priceLow: num(priceLow),
        priceHigh: num(priceHigh),
        lotSize: num(lotSize),
        maxShares: num(maxShares),
        subscribeStart: subscribeStart || undefined,
        subscribeEnd: subscribeEnd || undefined,
        allotmentDate: allotmentDate || undefined,
        listingDate: listingDate || undefined,
        sponsor: sponsor.trim() || undefined,
        industry: industry.trim() || undefined,
        prospectusUrl: prospectusUrl.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success('已录入新股', `${name}（${code}）`);
      onClose();
      setCode('');
      setName('');
      setSubscribeCode('');
      setIssuePrice('');
      setPriceLow('');
      setPriceHigh('');
      setLotSize('');
      setMaxShares('');
      setSubscribeStart('');
      setSubscribeEnd('');
      setAllotmentDate('');
      setListingDate('');
      setSponsor('');
      setIndustry('');
      setProspectusUrl('');
      setNote('');
      props.onCreated();
    } catch (error) {
      toast.error('录入失败', toApiError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="手动录入新股"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex" style={{ flexDirection: 'column', gap: 12 }}>
        <Segmented
          value={market}
          onChange={(value) => setMarket(value)}
          options={MARKETS.map((key) => ({ value: key, label: MARKET_LABELS[key] }))}
        />
        <div className="form-grid">
          <Field label="上市代码" hint="必填">
            <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="例如 001381 / 06157 / CTY" />
          </Field>
          <Field label="名称" hint="必填">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="申购代码" hint="A 股 732/787 开头，可留空">
            <Input value={subscribeCode} onChange={(event) => setSubscribeCode(event.target.value)} />
          </Field>
          <Field label="发行价" hint="未定价留空">
            <Input value={issuePrice} inputMode="decimal" onChange={(event) => setIssuePrice(event.target.value)} />
          </Field>
          <Field label="招股价区间下限">
            <Input value={priceLow} inputMode="decimal" onChange={(event) => setPriceLow(event.target.value)} />
          </Field>
          <Field label="招股价区间上限">
            <Input value={priceHigh} inputMode="decimal" onChange={(event) => setPriceHigh(event.target.value)} />
          </Field>
          <Field label="每手股数 / 申购单位">
            <Input value={lotSize} inputMode="numeric" onChange={(event) => setLotSize(event.target.value)} />
          </Field>
          <Field label="申购上限（股）">
            <Input value={maxShares} inputMode="numeric" onChange={(event) => setMaxShares(event.target.value)} />
          </Field>
          <Field label="申购开始">
            <Input type="date" value={subscribeStart} onChange={(event) => setSubscribeStart(event.target.value)} />
          </Field>
          <Field label="申购截止">
            <Input type="date" value={subscribeEnd} onChange={(event) => setSubscribeEnd(event.target.value)} />
          </Field>
          <Field label="中签 / 定价日">
            <Input type="date" value={allotmentDate} onChange={(event) => setAllotmentDate(event.target.value)} />
          </Field>
          <Field label="上市日">
            <Input type="date" value={listingDate} onChange={(event) => setListingDate(event.target.value)} />
          </Field>
          <Field label="保荐 / 承销">
            <Input value={sponsor} onChange={(event) => setSponsor(event.target.value)} />
          </Field>
          <Field label="行业">
            <Input value={industry} onChange={(event) => setIndustry(event.target.value)} />
          </Field>
        </div>
        <Field label="招股书 / 公告链接">
          <Input value={prospectusUrl} onChange={(event) => setProspectusUrl(event.target.value)} placeholder="https://…" />
        </Field>
        <Field label="备注" hint="刷新时上游数据不会覆盖人工备注">
          <Textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}