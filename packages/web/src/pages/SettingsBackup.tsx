/**
 * 数据备份与恢复区块 — owner: web-ai-pages.
 * 导出全部数据（JSON 下载）· 导入（merge/replace）· 服务端快照。
 */
import { useRef, useState } from 'react';
import type { BackupPayload, ImportMode, ImportResult } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAsync } from '../api/hooks';
import { fmtCompact, fmtDateTime, fmtNum, todayIso } from '../format';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorAlert, Loading, Segmented, useToast } from '../components/ui';

const MODE_OPTIONS: { value: ImportMode; label: string }[] = [
  { value: 'merge', label: '合并（保留现有数据）' },
  { value: 'replace', label: '替换（清空后导入）' },
];

export function BackupCard() {
  const toast = useToast();
  const [nonce, setNonce] = useState(0);
  const files = useAsync(() => api.backup.files(), [nonce]);
  const [exporting, setExporting] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>('merge');
  const [payload, setPayload] = useState<BackupPayload | null>(null);
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function exportAll() {
    setExporting(true);
    try {
      const data = await api.backup.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ai-investor-backup-${todayIso()}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success('已导出全部数据', `${data.assets.length} 个资产 · ${data.watchlist.length} 个标的 · ${data.advice.length} 条建议`);
    } catch (error) {
      toast.error('导出失败', toApiError(error).message);
    } finally {
      setExporting(false);
    }
  }

  async function pickFile(file: File | null) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as BackupPayload;
      if (!parsed || parsed.schema !== 'ai-investment-advisor/backup') {
        toast.error('文件格式不正确', '需要由本应用「导出全部数据」生成的备份 JSON');
        return;
      }
      setPayload(parsed);
      setFileName(file.name);
      setResult(null);
      toast.info('已读取备份文件', `${parsed.assets.length} 个资产 · ${parsed.watchlist.length} 个标的 · ${parsed.advice.length} 条建议`);
    } catch (error) {
      toast.error('读取失败', (error as Error).message);
    }
  }

  async function runImport() {
    if (!payload) return;
    setImporting(true);
    try {
      const imported = await api.backup.import(payload, importMode);
      setResult(imported);
      setPayload(null);
      setFileName('');
      setConfirmReplace(false);
      if (fileRef.current) fileRef.current.value = '';
      toast.success('导入完成', `资产 ${imported.assets} · 交易 ${imported.transactions} · 标的 ${imported.watchlist} · 建议 ${imported.advice}`);
    } catch (error) {
      toast.error('导入失败', toApiError(error).message);
    } finally {
      setImporting(false);
    }
  }

  async function createSnapshot() {
    setSnapshotting(true);
    try {
      const file = await api.backup.snapshot();
      toast.success('服务端快照已创建', `${file.name} · ${fmtCompact(file.size)}`);
      setNonce((value) => value + 1);
    } catch (error) {
      toast.error('创建快照失败', toApiError(error).message);
    } finally {
      setSnapshotting(false);
    }
  }

  const snapshots = files.data ?? [];

  return (
    <Card
      title="数据备份与恢复"
      actions={
        <div className="toolbar">
          <Button size="sm" variant="primary" loading={exporting} onClick={() => void exportAll()}>
            导出全部数据
          </Button>
          <Button size="sm" loading={snapshotting} onClick={() => void createSnapshot()}>
            创建服务端快照
          </Button>
        </div>
      }
    >
      <div className="grid-2">
        <div className="panel">
          <div className="small strong mb-2">导入备份</div>
          <input
            ref={fileRef}
            className="input"
            type="file"
            accept=".json,application/json"
            onChange={(event) => void pickFile(event.target.files?.[0] ?? null)}
          />
          {fileName && (
            <div className="tiny mute mt-1">
              已选择：<span className="mono">{fileName}</span>
            </div>
          )}
          <div className="mt-2">
            <Segmented value={importMode} options={MODE_OPTIONS} onChange={setImportMode} />
          </div>
          <div className="tiny mute mt-2">
            {importMode === 'merge'
              ? '合并：保留现有数据，按 id 去重后新增缺失记录。'
              : '替换：先清空现有资产 / 交易 / 标的 / 建议，再导入备份内容。'}
          </div>
          <div className="toolbar mt-3">
            <Button
              variant={importMode === 'replace' ? 'danger' : 'primary'}
              disabled={!payload}
              loading={importing}
              onClick={() => (importMode === 'replace' ? setConfirmReplace(true) : void runImport())}
            >
              {importMode === 'replace' ? '替换导入' : '合并导入'}
            </Button>
            {payload && (
              <Button
                variant="ghost"
                onClick={() => {
                  setPayload(null);
                  setFileName('');
                  if (fileRef.current) fileRef.current.value = '';
                }}
              >
                取消选择
              </Button>
            )}
          </div>

          {result && (
            <div className="mt-3">
              <div className="small strong mb-1">
                导入结果 <Badge tone="ok">{result.mode === 'replace' ? '替换' : '合并'}</Badge>
              </div>
              <div className="kv">
                <dt>资产</dt>
                <dd>{fmtNum(result.assets, 0)}</dd>
                <dt>交易</dt>
                <dd>{fmtNum(result.transactions, 0)}</dd>
                <dt>标的</dt>
                <dd>{fmtNum(result.watchlist, 0)}</dd>
                <dt>建议</dt>
                <dd>{fmtNum(result.advice, 0)}</dd>
                <dt>跳过</dt>
                <dd>{fmtNum(result.skipped, 0)}</dd>
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="between mb-2">
            <div className="small strong">服务端快照（data/backups）</div>
            <Button size="sm" variant="ghost" onClick={files.reload}>
              刷新
            </Button>
          </div>
          <ErrorAlert error={files.error} onRetry={files.reload} />
          {files.loading && !files.data && <Loading label="读取快照列表…" />}
          {!files.loading && snapshots.length === 0 && <Empty title="暂无快照" hint="点击「创建服务端快照」在服务器 data/backups 下生成一份备份文件。" />}
          {snapshots.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>文件名</th>
                    <th className="num">大小</th>
                    <th>创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshots.map((file) => (
                    <tr key={file.name}>
                      <td className="mono tiny">{file.name}</td>
                      <td className="num">{fmtCompact(file.size)}</td>
                      <td className="nowrap">{fmtDateTime(file.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReplace}
        danger
        busy={importing}
        title="替换导入备份"
        confirmLabel="清空并导入"
        message={
          <>
            将<strong>清空现有</strong>资产、交易、标的与建议，然后导入
            <strong> {fileName || '该备份文件'}</strong> 的内容。此操作不可撤销，建议先「导出全部数据」。
          </>
        }
        onCancel={() => setConfirmReplace(false)}
        onConfirm={() => void runImport()}
      />
    </Card>
  );
}
