/**
 * 模型名输入 + 可搜索下拉 — owner: web-ai-pages.
 *
 * 行为：输入框获得焦点时向服务端请求 `{baseUrl}/models`（服务端用已保存的 Key，
 * 或草稿里刚填的 Key），把结果做成可筛选下拉；同一「Base URL + Key」的结果会缓存，
 * 改地址或改 Key 后自动失效。拉取失败不影响手填：错误信息显示在下方，输入框照常可用，
 * 也能用「自定义」供应商接任意地址。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { toApiError } from '../api/hooks';
import { Input } from '../components/ui';

/** 下拉最多渲染多少条，避免网关返回上千个模型时卡顿。 */
const MAX_RENDERED = 300;

export function ModelField(props: {
  value: string;
  onChange: (value: string) => void;
  baseUrl: string;
  /** 草稿里刚填的 Key；为空表示沿用服务端已保存的 Key。 */
  apiKey: string;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement | null>(null);
  /** 上次成功加载对应的「地址|Key」，用于缓存命中判断。 */
  const loadedKey = useRef('');

  const baseUrl = props.baseUrl.trim();
  const apiKey = props.apiKey.trim();
  const cacheKey = `${baseUrl}|${apiKey}`;

  const load = useCallback(async () => {
    if (!baseUrl.startsWith('http')) {
      setState('error');
      setMessage('请先填写 Base URL（形如 https://api.deepseek.com/v1）');
      return;
    }
    if (loadedKey.current === cacheKey && state === 'ready') {
      setOpen(true);
      return;
    }
    setState('loading');
    setMessage('');
    try {
      const result = await api.settings.models({ baseUrl, apiKey: apiKey || undefined });
      if (!result.ok) {
        setState('error');
        setModels([]);
        setMessage(result.message || '无法获取模型列表');
        setOpen(false);
        return;
      }
      loadedKey.current = cacheKey;
      setModels(result.models);
      setState('ready');
      setOpen(true);
    } catch (error) {
      setState('error');
      setModels([]);
      setMessage(toApiError(error).message);
      setOpen(false);
    }
  }, [apiKey, baseUrl, cacheKey, state]);

  // 点击下拉之外的区域即收起。
  useEffect(() => {
    function onDocMouseDown(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = keyword === '' ? models : models.filter((model) => model.toLowerCase().includes(keyword));
    return list.slice(0, MAX_RENDERED);
  }, [models, query]);

  function pick(model: string) {
    props.onChange(model);
    setQuery('');
    setOpen(false);
  }

  return (
    <div ref={boxRef} className="dropdown-anchor">
      <Input
        value={props.value}
        placeholder={state === 'loading' ? '正在获取模型列表…' : '点击此处自动获取模型列表，或手动填写'}
        aria-label="模型名"
        onFocus={() => void load()}
        onChange={(event) => {
          props.onChange(event.target.value);
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          else if (event.key === 'Enter' && open && filtered.length === 1) pick(filtered[0]);
        }}
      />

      {open && filtered.length > 0 && (
        <div
          className="dropdown-panel liquid"
          role="listbox"
          aria-label="可选模型"
          style={{ top: 'calc(100% + 4px)', right: 0, maxHeight: 260, zIndex: 40 }}
        >
          {filtered.map((model) => {
            const active = model === props.value;
            return (
              <button
                key={model}
                type="button"
                role="option"
                aria-selected={active}
                className="dropdown-option dropdown-option-mono"
                onClick={() => pick(model)}
              >
                <span className="truncate">{model}</span>
              </button>
            );
          })}
        </div>
      )}

      <span className="field-hint">
        {state === 'idle' && '点击输入框自动拉取该地址的模型列表，支持输入关键字筛选；也可直接手填。'}
        {state === 'loading' && '正在向该地址请求模型列表…'}
        {state === 'ready' && `已获取 ${models.length} 个模型，输入关键字可筛选，点选即填入。`}
        {state === 'error' && <span style={{ color: 'var(--warn)' }}>未获取到模型列表：{message}（仍可手动填写）</span>}
      </span>
    </div>
  );
}
