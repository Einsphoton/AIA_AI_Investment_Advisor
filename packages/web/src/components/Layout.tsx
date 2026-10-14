/**
 * Application chrome: ambient FX layer + sidebar + page header. Owner: Lead.
 *
 * Rendering notes (all progressive enhancement, no extra assets):
 *   · `.fx-layer` paints one *static* warm aurora wash plus a faint vignette
 *     (v3 flat direction: no grid / spotlight / scan / grain, no animation);
 *     it is `pointer-events: none` and `aria-hidden`.
 *   · the clock only ticks after mount so the server-rendered markup stays
 *     deterministic.
 */
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Badge } from './ui';
import { PendingWritesBar } from './PendingWritesBar';

interface NavEntry {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const NAV: NavEntry[] = [
  { to: '/', label: 'Dashboard', icon: '◎', end: true },
  { to: '/assets', label: '我的资产', icon: '▤' },
  { to: '/watchlist', label: '我的标的', icon: '☆' },
  { to: '/advice', label: 'AI 投资建议', icon: '✦' },
  { to: '/chat', label: 'AI Chat', icon: '✎' },
  { to: '/activity', label: '活动与审计', icon: '⏱' },
  { to: '/settings', label: '设置', icon: '⚙' },
];

interface PageMeta {
  title: string;
  subtitle: string;
  /** Small tracked Latin label above the title — decorative, not a11y text. */
  eyebrow: string;
}

const TITLES: Record<string, PageMeta> = {
  '/': { title: 'Dashboard', subtitle: '持仓概览 · AI 简报 · 关键信号', eyebrow: 'Portfolio Overview' },
  '/assets': { title: '我的资产', subtitle: '持仓、交易记录与逐项 AI 分析', eyebrow: 'Asset Ledger' },
  '/watchlist': { title: '我的标的', subtitle: '自选池与 AI 挖掘出的候选标的', eyebrow: 'Watch Universe' },
  '/advice': { title: 'AI 投资建议', subtitle: '买入 / 卖出建议与月度预算约束', eyebrow: 'Advisory Engine' },
  '/chat': { title: 'AI Chat', subtitle: '与 Agent 对话，下达指令让它调用工具完成任务', eyebrow: 'Agent Console' },
  '/activity': { title: '活动与审计', subtitle: '运行轨迹回放 · 续跑 · 写入审计 · 待审批', eyebrow: 'Audit Trail' },
  '/settings': { title: '设置', subtitle: 'API Key · 投资性格 · 数据源 · 预算 · 工具策略 · MCP · 定时任务 · 备份', eyebrow: 'System Config' },
};

const FALLBACK_META: PageMeta = { title: 'AI 投资顾问', subtitle: '', eyebrow: 'AI Investment Advisor' };

/** Live wall clock for the header status rail (empty until mounted). */
function useClock(): string {
  const [clock, setClock] = useState('');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
    tick();
    timer.current = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer.current);
  }, []);
  return clock;
}

export function Layout() {
  const location = useLocation();
  const meta = TITLES[location.pathname] ?? FALLBACK_META;
  const [pendingAdvice, setPendingAdvice] = useState(0);
  const [llmReady, setLlmReady] = useState<boolean | null>(null);
  const clock = useClock();

  useEffect(() => {
    let alive = true;
    api.settings
      .get()
      .then((settings) => {
        if (alive) setLlmReady(settings.hasApiKey);
      })
      .catch(() => {
        if (alive) setLlmReady(null);
      });
    api.advice
      .list('pending')
      .then((result) => {
        if (alive) setPendingAdvice(result.items.length);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [location.pathname]);

  return (
    <>
      {/* ambient render stack — purely decorative: one static warm wash + vignette */}
      <div className="fx-layer" aria-hidden="true">
        <div className="fx-aurora">
          <span />
          <span />
        </div>
        <div className="fx-vignette" />
      </div>

      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-logo" aria-hidden="true">
              <span className="logo-text">AI</span>
            </div>
            <div>
              <div className="sidebar-title">投资顾问</div>
              <div className="sidebar-sub">Self-hosted Agent</div>
            </div>
          </div>

          <nav className="nav">
            {NAV.map((entry) => (
              <NavLink key={entry.to} to={entry.to} end={entry.end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <span className="nav-icon">{entry.icon}</span>
                <span>{entry.label}</span>
                {entry.to === '/advice' && pendingAdvice > 0 && <span className="nav-badge">{pendingAdvice}</span>}
              </NavLink>
            ))}
          </nav>

          <div className="sidebar-footer">
            {llmReady === false && (
              <div>
                <Badge tone="warn">未配置 API Key</Badge>
              </div>
            )}
            {llmReady === true && (
              <div>
                <Badge tone="ok">模型已就绪</Badge>
              </div>
            )}
            <div className="sidebar-meta">
              <div className="meta-row">
                <span className="meta-key">Sources</span>
                <span className="meta-val">东方财富 · 腾讯 · 天天基金</span>
              </div>
              <div className="meta-row">
                <span className="meta-key">Local Time</span>
                <span className="meta-val mono">{clock || '--:--:--'}</span>
              </div>
            </div>
          </div>
        </aside>

        <main className="main">
          <header className="page-header">
            <div className="page-heading">
              <div className="page-eyebrow">{meta.eyebrow}</div>
              <h1 className="page-title">{meta.title}</h1>
              {meta.subtitle && <div className="page-subtitle">{meta.subtitle}</div>}
            </div>
            <div className="page-status">
              <span className="status-chip">
                <span className="status-led" />
                System Online
              </span>
              <span className="status-chip mono">{clock || '--:--:--'}</span>
            </div>
          </header>
          {/* P1-1: global "AI writes awaiting approval" banner (renders nothing when empty). */}
          <PendingWritesBar />
          <Outlet />
        </main>
      </div>
    </>
  );
}
