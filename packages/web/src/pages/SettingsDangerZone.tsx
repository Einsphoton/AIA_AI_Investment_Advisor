/**
 * 危险操作：一键清除所有数据 — owner: web-ai-pages.
 *
 * 与上方「数据备份与恢复」配套：导出 / 快照是后路，这里是一次性清空。
 * 默认保留 AI 配置（含 API Key），只有显式勾选才恢复出厂设置；服务端
 * `data/backups` 下的快照文件不在此操作范围内，因此清空后仍可恢复。
 */
import { useState } from 'react';
import type { ClearDataResult } from '@aia/shared';
import { api } from '../api/client';
import { toApiError } from '../api/hooks';
import { Badge, Button, Card, Checkbox, ConfirmDialog, useToast } from '../components/ui';

export function DangerZoneCard(props: { onCleared?: (result: ClearDataResult) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  /** 勾选后连 AI 配置一起清（恢复出厂设置）；默认不勾选，避免误删 API Key。 */
  const [withSettings, setWithSettings] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [last, setLast] = useState<ClearDataResult | null>(null);

  function close() {
    if (clearing) return;
    setOpen(false);
    setWithSettings(false);
  }

  async function clearAll() {
    setClearing(true);
    try {
      const result = await api.backup.clear({ keepSettings: !withSettings });
      setLast(result);
      setOpen(false);
      setWithSettings(false);
      toast.success(
        '已清除全部数据',
        `共删除 ${result.deleted} 条记录${result.settingsReset ? '，AI 配置与 API Key 已恢复默认' : '；AI 配置与 API Key 保持不变'}`,
      );
      props.onCleared?.(result);
    } catch (error) {
      // 流水线运行中服务端会拒绝（409）：保持弹窗打开，用户可稍后重试。
      toast.error('清除失败', toApiError(error).message);
    } finally {
      setClearing(false);
    }
  }

  return (
    <Card
      title={
        <span className="center gap-2">
          危险操作
          <Badge tone="warn">不可撤销</Badge>
        </span>
      }
      actions={
        <Button size="sm" variant="danger" disabled={clearing} onClick={() => setOpen(true)}>
          一键清除所有数据
        </Button>
      }
    >
      <div className="tiny muted">
        一次性删除全部资产与交易、全部标的（含已退役）、全部 AI 投资建议与建议追踪、全部 AI 运行记录与对话，
        并清空本地缓存（汇率 / 简报）。默认<strong>保留 AI 配置与 API Key</strong>；备份目录{' '}
        <span className="mono">data/backups</span> 下的快照文件不会被删除。
      </div>

      {last && (
        <div className="tiny mute mt-2">
          上次清除：资产 {last.assets} · 交易 {last.transactions} · 标的 {last.watchlist} · 建议 {last.advice} · 建议追踪{' '}
          {last.adviceOutcomes} · AI 运行 {last.runs} · 对话 {last.chatSessions} · 缓存 {last.kvEntries}
          {last.settingsReset ? ' · AI 配置已恢复默认' : ' · AI 配置保持不变'}
        </div>
      )}

      <ConfirmDialog
        open={open}
        danger
        busy={clearing}
        title="一键清除所有数据"
        confirmLabel="确认清除"
        onCancel={close}
        onConfirm={() => void clearAll()}
        message={
          <>
            <div>
              将<strong>永久删除</strong>：全部资产与交易、全部标的（含已退役）、全部 AI 投资建议与建议追踪、
              全部 AI 运行记录与对话，以及本地缓存（汇率 / 简报）。此操作<strong>不可撤销</strong>，
              建议先在上方「数据备份与恢复」里点「导出全部数据」或「创建服务端快照」。
            </div>
            <div className="mt-3">
              <Checkbox
                checked={withSettings}
                disabled={clearing}
                onChange={setWithSettings}
                label="同时清除 AI 配置与 API Key（恢复出厂设置）"
              />
            </div>
            <div className="tiny mute mt-2">
              {withSettings
                ? '将一并清空 LLM API Key、数据源 Key，以及投资性格 / 报告风格 / 预算 / 定时任务等全部设置（定时任务会关闭）。'
                : '不勾选：AI 配置、API Key、投资性格、预算与定时任务全部保留，清除后可立即继续使用。'}
            </div>
          </>
        }
      />
    </Card>
  );
}
