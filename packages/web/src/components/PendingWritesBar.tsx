/**
 * 全局待审批写入提示条（P1-1） — owner: web-ai-pages.
 *
 * 当 `toolPolicy.requireWriteApproval` 打开时，AI 的写入工具调用不会直接落库，
 * 而是进入 `GET /api/agent/pending?status=pending`。本组件每 15 秒轮询一次，
 * 数量为 0 时完全不渲染，避免打扰；由 Layout 挂在全局位置。
 */
import { useState } from 'react';
import type { PendingWrite } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync, usePolling } from '../api/hooks';
import { fmtRelative } from '../format';
import { Badge, Button, Modal, Textarea, useToast } from './ui';

/** 轮询间隔：15 秒（挂载时 useAsync 会先拉一次）。 */
const POLL_MS = 15_000;
/** 参数 JSON 在弹窗里的最大展示长度。 */
const ARGS_LIMIT = 800;

const RISK_LABEL: Record<string, string> = { read: '只读', external: '外部', write: '写入' };

function riskTone(risk: string): 'sell' | 'warn' | 'ok' {
  if (risk === 'write') return 'sell';
  if (risk === 'external') return 'warn';
  return 'ok';
}

/** 参数为 JSON 字符串（服务端已截断），仅在展示层再截断一次。 */
function argsPreview(args: string): string {
  if (!args || args.trim() === '') return '（无参数）';
  return args.length > ARGS_LIMIT ? `${args.slice(0, ARGS_LIMIT)}\n…（已截断）` : args;
}

export function PendingWritesBar(props: { onDone?: () => void }) {
  const toast = useToast();
  const pending = useAsync(() => api.agent.pending('pending'), []);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingWrite | null>(null);
  const [reason, setReason] = useState('');

  usePolling(() => pending.reload(), POLL_MS);

  const items = pending.data ?? [];
  if (items.length === 0 && !open) return null;

  function drop(id: string) {
    pending.setData((previous) => (previous ?? []).filter((entry) => entry.id !== id));
  }

  async function approve(item: PendingWrite) {
    setBusyId(item.id);
    try {
      await api.agent.approvePending(item.id);
      drop(item.id);
      toast.success(`已批准并执行：${item.id.slice(0, 8)}`);
      props.onDone?.();
    } catch (error) {
      toast.error('批准失败', toApiError(error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function reject() {
    const target = rejectTarget;
    if (!target) return;
    setBusyId(target.id);
    try {
      await api.agent.rejectPending(target.id, reason.trim() || undefined);
      drop(target.id);
      toast.success(`已驳回：${target.id.slice(0, 8)}`);
      props.onDone?.();
      setRejectTarget(null);
      setReason('');
    } catch (error) {
      toast.error('驳回失败', toApiError(error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div
        className="panel mb-3"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}
      >
        <div className="center gap-2">
          <Badge tone="warn">待审批</Badge>
          <span className="small strong">{items.length} 项 AI 写入等待审批</span>
        </div>
        <div className="toolbar">
          <Button size="sm" variant="ghost" loading={pending.loading} onClick={() => pending.reload()}>
            刷新
          </Button>
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            查看
          </Button>
        </div>
      </div>

      <Modal open={open} title={`待审批写入（${items.length}）`} onClose={() => setOpen(false)} size="lg">
        <div className="tiny mute mb-3">
          这些写入由 AI 发起但尚未落库。批准会立即执行该工具调用；驳回会把拒绝理由回传给模型。
        </div>

        {items.length === 0 && <div className="tiny mute">当前没有待审批的写入。</div>}

        <div className="flex" style={{ flexDirection: 'column', gap: 10 }}>
          {items.map((item) => (
            <div key={item.id} className="panel">
              <div className="between wrap gap-2">
                <div className="center gap-2">
                  <span className="mono small strong">{item.tool}</span>
                  <Badge tone={riskTone(item.risk)}>{RISK_LABEL[item.risk] ?? item.risk}</Badge>
                  <span className="tiny mute mono">{item.id.slice(0, 8)}</span>
                </div>
                <span className="tiny mute">{fmtRelative(item.createdAt)}</span>
              </div>

              {item.summary && <div className="tiny muted mt-1">{item.summary}</div>}
              {item.runId && <div className="tiny mute mt-1 mono">run {item.runId.slice(0, 8)}</div>}

              <pre
                className="tiny mono mt-2"
                style={{ whiteSpace: 'pre-wrap', maxHeight: 180, overflowY: 'auto', margin: 0, color: 'var(--text-dim)' }}
              >
                {argsPreview(item.args)}
              </pre>

              <div className="toolbar mt-2">
                <Button size="sm" variant="primary" loading={busyId === item.id} onClick={() => void approve(item)}>
                  批准
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busyId === item.id}
                  onClick={() => {
                    setRejectTarget(item);
                    setReason('');
                  }}
                >
                  驳回
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={rejectTarget !== null}
        title="驳回写入"
        onClose={() => setRejectTarget(null)}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejectTarget(null)} disabled={busyId !== null}>
              取消
            </Button>
            <Button variant="danger" loading={busyId !== null} onClick={() => void reject()}>
              确认驳回
            </Button>
          </>
        }
      >
        <div className="tiny muted mb-2">
          工具 <span className="mono">{rejectTarget?.tool}</span> 不会被执行，拒绝理由会回传给 Agent。
        </div>
        <Textarea
          rows={3}
          value={reason}
          placeholder="驳回原因（可选，例如：标的不符合当前策略）"
          onChange={(event) => setReason(event.target.value)}
        />
      </Modal>
    </>
  );
}
