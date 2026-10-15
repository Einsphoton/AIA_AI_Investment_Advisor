/**
 * Top-left version badge (owner: Lead).
 *
 * Shows the version of the *loaded bundle* (`BUNDLE_VERSION`, injected from the
 * root package.json at build time) and, once `GET /api/version` answers, the
 * build identity of the server that answers it:
 *
 *   · normal     `v0.1.0 · a1b2c3d`
 *   · mismatch   `v0.1.0 ≠ v0.2.0` + red pill: the browser is running a stale
 *                `app.js` against a newer API — the failure mode that otherwise
 *                looks like "the UI is randomly wrong" after a deployment
 *   · API down   keeps showing the bundle version, details mark the API as
 *                unreachable (a version badge must never disappear).
 *
 * Details live in a `HoverTip` (hover / focus / tap) so the corner stays compact.
 */
import { useEffect, useState } from 'react';
import { formatVersionLabel, hasVersionValue, isVersionMismatch, VERSION_UNKNOWN, type AppVersionPayload } from '@aia/shared';

import { api } from '../api/client';
import { fmtDateTime } from '../format';
import { BUNDLE_VERSION } from '../version';
import { HoverTip } from './ui';

/** Renders whole seconds as `3天 4小时` / `12分钟` / `40秒`. */
function fmtUptime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟`;
  return `${total}秒`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="version-detail-row">
      <span className="version-detail-key">{label}</span>
      <span className="version-detail-val">{value}</span>
    </div>
  );
}

export function VersionBadge() {
  const [info, setInfo] = useState<AppVersionPayload | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .version()
      .then((payload) => {
        if (alive) setInfo(payload);
      })
      .catch(() => {
        if (alive) setUnreachable(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const apiVersion = info?.version ?? '';
  const mismatch = isVersionMismatch(BUNDLE_VERSION, apiVersion);
  // Before the API answers (and if it never does) fall back to the bundle copy.
  const label = mismatch
    ? `${formatVersionLabel(BUNDLE_VERSION)} ≠ ${formatVersionLabel(apiVersion)}`
    : formatVersionLabel(BUNDLE_VERSION || apiVersion, info?.commit);

  const detail = (
    <div className="version-detail">
      <DetailRow label="前端" value={hasVersionValue(BUNDLE_VERSION) ? `v${BUNDLE_VERSION}` : VERSION_UNKNOWN} />
      <DetailRow
        label="服务端"
        value={info ? `v${info.version}` : unreachable ? '不可达' : '查询中…'}
      />
      {info && <DetailRow label="构建提交" value={hasVersionValue(info.commit) ? info.commit : VERSION_UNKNOWN} />}
      {info && <DetailRow label="分支" value={hasVersionValue(info.branch) ? info.branch : VERSION_UNKNOWN} />}
      {info && <DetailRow label="构建时间" value={hasVersionValue(info.builtAt) ? fmtDateTime(info.builtAt) : VERSION_UNKNOWN} />}
      {info && <DetailRow label="运行环境" value={info.environment} />}
      {info && <DetailRow label="Node" value={info.node} />}
      {info && <DetailRow label="已运行" value={fmtUptime(info.uptimeSeconds)} />}
      {mismatch && (
        <p className="version-detail-note">
          前端 v{BUNDLE_VERSION} 与服务端 v{apiVersion} 不一致：本页可能仍在用浏览器缓存的旧版 app.js，
          请强制刷新（Ctrl/Cmd + Shift + R），或等待部署完成。
        </p>
      )}
      {unreachable && <p className="version-detail-note">无法读取服务端版本：/api/version 请求失败，版本号取自本次加载的前端产物。</p>}
    </div>
  );

  return (
    <HoverTip title="版本" label="查看版本信息" content={detail}>
      <span className={`version-badge${mismatch ? ' version-badge-warn' : ''}`}>
        <span className="version-badge-dot" aria-hidden="true" />
        <span className="version-badge-label">{label}</span>
      </span>
    </HoverTip>
  );
}
