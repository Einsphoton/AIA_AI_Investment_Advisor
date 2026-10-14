/**
 * 「添加标的」浮窗 — owner: web-ai-pages.
 * 输入市场代码后调用 `/api/market/search` 自动补全名称，再 POST /api/watchlist。
 */
import { useEffect, useState } from 'react';
import { INSTRUMENT_TYPES, INSTRUMENT_TYPE_LABELS, MARKETS, MARKET_LABELS } from '@aia/shared';
import type { InstrumentType, Market } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync, useDebounced } from '../api/hooks';
import { Button, Dropdown, Field, Input, Modal, useToast } from '../components/ui';

export function AddWatchItemDialog(props: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [type, setType] = useState<InstrumentType>('stock');
  const [market, setMarket] = useState<Market>('CN');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const debouncedCode = useDebounced(code, 300);

  useEffect(() => {
    if (!props.open) return;
    setType('stock');
    setMarket('CN');
    setCode('');
    setName('');
    setPicked(false);
  }, [props.open]);

  const suggestions = useAsync(
    () => (debouncedCode.trim().length >= 1 ? api.market.search(debouncedCode.trim(), market) : Promise.resolve([])),
    [debouncedCode, market],
  );
  const showSuggestions = !picked && code.trim().length >= 1 && (suggestions.data?.length ?? 0) > 0;

  async function submit() {
    if (!code.trim()) {
      toast.error('请填写市场代码');
      return;
    }
    setSubmitting(true);
    try {
      const item = await api.watchlist.create({ code: code.trim(), market, type, name: name.trim() || undefined });
      toast.success('已添加标的', `${item.name || item.code} · ${MARKET_LABELS[item.market]}`);
      props.onCreated();
      props.onClose();
    } catch (error) {
      const err = toApiError(error);
      toast.error('添加失败', err.isNotConfigured ? '服务端未配置 LLM API Key，无法自动补全名称；请到「设置」页填写' : err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={props.open}
      title="添加标的"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose} disabled={submitting}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            添加
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="类型">
          <Dropdown
            value={type}
            ariaLabel="标的类型"
            onChange={(next) => setType(next as InstrumentType)}
            items={INSTRUMENT_TYPES.map((key) => ({ value: key, label: INSTRUMENT_TYPE_LABELS[key] }))}
          />
        </Field>
        <Field label="市场">
          <Dropdown
            value={market}
            ariaLabel="市场"
            onChange={(next) => {
              setMarket(next as Market);
              setPicked(false);
            }}
            items={MARKETS.map((key) => ({ value: key, label: MARKET_LABELS[key] }))}
          />
        </Field>
        <div className="field span-2">
          <span className="field-label">市场代码</span>
          <Input
            value={code}
            placeholder="例如 600519 / 00700 / AAPL"
            onChange={(event) => {
              setCode(event.target.value);
              setPicked(false);
            }}
          />
          {showSuggestions && (
            <div className="panel mt-1" style={{ maxHeight: 200, overflowY: 'auto', padding: 6 }}>
              {(suggestions.data ?? []).slice(0, 8).map((hit) => (
                <button
                  key={`${hit.market}-${hit.code}`}
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ width: '100%', justifyContent: 'space-between', marginBottom: 2 }}
                  onClick={() => {
                    setCode(hit.code);
                    setName(hit.name);
                    setMarket(hit.market);
                    setType(hit.type);
                    setPicked(true);
                  }}
                >
                  <span className="truncate">
                    {hit.name} <span className="mute mono tiny">{hit.code}</span>
                  </span>
                  <span className="tiny mute nowrap">
                    {MARKET_LABELS[hit.market]} · {hit.exchange || INSTRUMENT_TYPE_LABELS[hit.type]}
                  </span>
                </button>
              ))}
            </div>
          )}
          <span className="field-hint">输入代码后自动补全名称；也可直接填写下方名称。</span>
        </div>
        <Field label="标的名称（可选）" className="span-2">
          <Input value={name} placeholder="留空则由数据源自动补全" onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
