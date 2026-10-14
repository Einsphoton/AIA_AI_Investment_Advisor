/**
 * Shared UI kit. Owner: Lead — pages must reuse these primitives instead of
 * inventing per-page widgets, so the app looks uniform.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';

/* ──────────────────────────────── Card ───────────────────────────────────── */

export function Card(props: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  padded?: boolean;
  /** Adds `.card-glow`: a stronger gold halo for the page's focal surface. */
  glow?: boolean;
}) {
  const { title, actions, children, className = '', bodyClassName = '', padded = true, glow = false } = props;
  return (
    <section className={`card ${glow ? 'card-glow' : ''} ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          <div className="card-title">{title}</div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? `card-body ${bodyClassName}` : bodyClassName}>{children}</div>
    </section>
  );
}

export function StatCard(props: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'default' | 'pos' | 'neg'; hint?: string }) {
  const toneClass = props.tone === 'pos' ? 'pos' : props.tone === 'neg' ? 'neg' : '';
  return (
    <div className="stat-card" title={props.hint}>
      <div className="stat-label">{props.label}</div>
      <div className={`stat-value ${toneClass}`}>{props.value}</div>
      {props.sub !== undefined && <div className="stat-sub">{props.sub}</div>}
    </div>
  );
}

/* ─────────────────────────────── Button ──────────────────────────────────── */

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
}

export function Button({ variant = 'default', size = 'md', loading, className = '', children, disabled, ...rest }: ButtonProps) {
  const variantClass = variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : variant === 'ghost' ? 'btn-ghost' : '';
  return (
    <button
      type="button"
      className={`btn ${variantClass} ${size === 'sm' ? 'btn-sm' : ''} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />}
      {children}
    </button>
  );
}

/* ──────────────────────────────── Badge ──────────────────────────────────── */

export function Badge({ children, tone = 'default', title }: { children: ReactNode; tone?: 'default' | 'buy' | 'sell' | 'ai' | 'manual' | 'warn' | 'ok'; title?: string }) {
  const toneClass = tone === 'default' ? '' : `badge-${tone}`;
  return (
    <span className={`badge ${toneClass}`} title={title}>
      {children}
    </span>
  );
}

/* ──────────────────────────────── fields ─────────────────────────────────── */

export function Field(props: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${props.className ?? ''}`}>
      {props.label && <span className="field-label">{props.label}</span>}
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`} {...rest} />;
}

/**
 * 自定义下拉（listbox）— 取代原生 `<select>`。
 *
 * 原生 `<select>` 的弹出层由 Windows/浏览器绘制，CSS 只能深色化，
 * 做不出黑金 + 液态玻璃，所以这里自己画：玻璃面板、金色选中、分组标签、
 * 键盘上下/Home/End/Enter/Esc/Tab、点击外部收起、空间不足时向上展开。
 *
 * 面板保持常驻 DOM（关闭时 `hidden`），这样服务端渲染也能输出全部选项文案。
 */
export interface DropdownOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface DropdownGroup {
  /** 分组标题（如「国内厂商」）。 */
  group: string;
  options: DropdownOption[];
}

export type DropdownItem = DropdownOption | DropdownGroup;

function isDropdownGroup(item: DropdownItem): item is DropdownGroup {
  return 'group' in item;
}

export function Dropdown(props: {
  value: string;
  items: DropdownItem[];
  onChange: (value: string) => void;
  /** `value` 未命中任何选项时显示（默认回退到原始 value）。 */
  placeholder?: string;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  style?: CSSProperties;
}) {
  const { items, onChange, value } = props;
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const flat = useMemo(
    () => items.flatMap((item) => (isDropdownGroup(item) ? item.options : [item])),
    [items],
  );
  const selected = flat.find((option) => option.value === value);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // 点击触发器和面板之外的区域即收起。
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // 打开时：空间不足就向上展开；焦点落到当前选中项（没有则落到第一项）。
  useEffect(() => {
    if (!open) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom;
      setUp(below < 280 && rect.top > below);
    }
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target =
        panel?.querySelector<HTMLElement>('[aria-selected="true"]') ??
        panel?.querySelector<HTMLElement>('.dropdown-option:not(:disabled)');
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function onPanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const options = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('.dropdown-option:not(:disabled)') ?? [])];
    if (options.length === 0) {
      if (event.key === 'Escape') close(true);
      return;
    }
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      options[(current + 1 + options.length) % options.length].focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      options[(current - 1 + options.length) % options.length].focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      options[0].focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      options[options.length - 1].focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close();
    }
  }

  function renderOption(option: DropdownOption, key: string) {
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={option.value === value}
        disabled={option.disabled}
        tabIndex={-1}
        className="dropdown-option"
        onClick={() => {
          onChange(option.value);
          close(true);
        }}
      >
        <span className="truncate">{option.label}</span>
      </button>
    );
  }

  return (
    <div ref={wrapRef} className={`dropdown ${props.className ?? ''}`} style={props.style}>
      <button
        ref={triggerRef}
        type="button"
        className={`dropdown-trigger ${props.size === 'sm' ? 'dropdown-trigger-sm' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={props.ariaLabel}
        title={props.title}
        disabled={props.disabled}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={onTriggerKeyDown}
      >
        <span>{selected ? selected.label : props.placeholder ?? value}</span>
        <span className="dropdown-caret" aria-hidden="true" />
      </button>

      <div
        ref={panelRef}
        className={`dropdown-panel liquid ${up ? 'dropdown-panel-up' : ''}`}
        role="listbox"
        aria-label={props.ariaLabel}
        hidden={!open}
        onKeyDown={onPanelKeyDown}
      >
        {flat.length === 0 && <div className="dropdown-empty">无可选项</div>}
        {items.map((item, index) =>
          isDropdownGroup(item) ? (
            <div key={`group-${index}`} role="group" aria-label={item.group}>
              <div className="dropdown-group-label">{item.group}</div>
              {item.options.map((option, optionIndex) => renderOption(option, `${index}-${optionIndex}`))}
            </div>
          ) : (
            renderOption(item, String(index))
          ),
        )}
      </div>
    </div>
  );
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`textarea ${className}`} {...rest} />;
}

export function Checkbox(props: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <label className="checkbox" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function Segmented<T extends string>(props: { value: T; options: { value: T; label: ReactNode }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={props.value === option.value}
          className={`segmented-item ${props.value === option.value ? 'active' : ''}`}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ──────────────────────────────── overlays ───────────────────────────────── */

export function Modal(props: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const { open, onClose } = props;
  useEffect(() => {
    if (!open) return;
    // Explicit DOM type: the bare `KeyboardEvent` identifier is ambiguous in this
    // module (React's synthetic event shares the name), and `window` wants the DOM one.
    const onKey = (event: WindowEventMap['keydown']) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;
  const sizeClass = props.size === 'lg' ? 'modal-lg' : props.size === 'md' ? 'modal-md' : '';
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal ${sizeClass} ${props.className ?? ''}`} role="dialog" aria-modal="true">
        <header className="modal-header">
          <div className="modal-title">{props.title}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{props.children}</div>
        {props.footer && <footer className="modal-footer">{props.footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel} disabled={props.busy}>
            取消
          </Button>
          <Button variant={props.danger ? 'danger' : 'primary'} onClick={props.onConfirm} loading={props.busy}>
            {props.confirmLabel ?? '确认'}
          </Button>
        </>
      }
    >
      <div>{props.message}</div>
    </Modal>
  );
}

/* ──────────────────────────────── feedback ───────────────────────────────── */

export function Spinner({ large }: { large?: boolean }) {
  return <span className={`spinner ${large ? 'spinner-lg' : ''}`} />;
}

export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="empty">
      <Spinner large />
      <div className="muted small">{label}</div>
    </div>
  );
}

export function Empty(props: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{props.title}</div>
      {props.hint && <div className="tiny">{props.hint}</div>}
      {props.action}
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return <div className={`alert alert-${tone}`}>{children}</div>;
}

export function ProgressBar({ value, max = 100 }: { value: number; max?: number }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="progress">
      <div className="progress-bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: { code: string; message: string } | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert tone="error">
      <div className="between">
        <span>
          <strong>{error.code}</strong> · {error.message}
        </span>
        {onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            重试
          </Button>
        )}
      </div>
    </Alert>
  );
}

/* ──────────────────────────────── toasts ─────────────────────────────────── */

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error' | 'warn';
  title: string;
  text?: string;
}

interface ToastApi {
  push: (kind: ToastItem['kind'], title: string, text?: string) => void;
  success: (title: string, text?: string) => void;
  error: (title: string, text?: string) => void;
  info: (title: string, text?: string) => void;
  warn: (title: string, text?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const push = useCallback((kind: ToastItem['kind'], title: string, text?: string) => {
    const id = ++counter.current;
    setItems((previous) => [...previous.slice(-4), { id, kind, title, text }]);
    setTimeout(() => setItems((previous) => previous.filter((item) => item.id !== id)), kind === 'error' ? 9000 : 4500);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, text) => push('success', title, text),
      error: (title, text) => push('error', title, text),
      info: (title, text) => push('info', title, text),
      warn: (title, text) => push('warn', title, text),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {items.length > 0 && (
        <div className="toast-stack">
          {items.map((item) => (
            <div key={item.id} className={`toast toast-${item.kind === 'info' ? 'info' : item.kind}`}>
              <div className="toast-title">{item.title}</div>
              {item.text && <div className="toast-text">{item.text}</div>}
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

/* ──────────────────────────────── misc bits ──────────────────────────────── */

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([key, value], index) => (
        <div key={index} style={{ display: 'contents' }}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Sortable table header cell. */
export function SortHeader(props: {
  label: ReactNode;
  field: string;
  sort: string;
  dir: 'asc' | 'desc';
  onSort: (field: string) => void;
  numeric?: boolean;
}) {
  const active = props.sort === props.field;
  const arrow = !active ? '' : props.dir === 'asc' ? ' ▲' : ' ▼';
  return (
    <th
      className={`sortable ${props.numeric ? 'num' : ''}`}
      onClick={() => props.onSort(props.field)}
      title="点击切换排序"
    >
      {props.label}
      <span className="mute">{arrow}</span>
    </th>
  );
}
