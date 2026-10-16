/**
 * AI 定时任务配置区块 — owner: web-ai-pages.
 *
 * 交互设计（2026-10 二次改版：从「每条任务一整屏表单」压成**紧凑列表**）：
 *   · 一行 = 一个任务：启用勾选 / 名称 / 触发方式 / 步骤 / 下次运行 / 编辑·删除；
 *   · 编辑表单**就地展开**（同一时刻只展开一条），默认收起 —— 3 个任务也只占 3 行；
 *   · 「下次运行」来自服务端实时排程（`signals.nextRuns`），不是前端猜的。
 *
 * 定时任务是数组：可并存多个任务，各自选择触发方式（每天固定时间 / 按间隔）与要跑的步骤。
 * 所有编辑只改本地草稿，由设置页的「保存设置」整体提交（`schedules` 整体替换，`[]` = 不排程）。
 */
import { useState } from 'react';
import type { ScheduleNextRun } from '@aia/shared';
import { MAX_SCHEDULES } from '@aia/shared';
import { Button, Card, Checkbox, ConfirmDialog, Dropdown, Field, Input, useToast } from '../components/ui';
import { fmtDateTime } from '../format';
import { newScheduleDraft, type ScheduleTaskDraft } from './settingsDraft';

/** 触发方式摘要（与服务端 `describeTask` 同一口径）。 */
function triggerText(task: ScheduleTaskDraft): string {
  return task.mode === 'interval' ? `每 ${task.intervalMinutes || '?'} 分钟` : `每天 ${task.dailyTime || '--:--'}`;
}

/** 步骤的紧凑写法：`资产·建议`（行内展示用）。 */
function stepsShort(task: ScheduleTaskDraft): string {
  const steps: string[] = [];
  if (task.runAssetAnalysis) steps.push('资产');
  if (task.runWatchlistAnalysis) steps.push('标的');
  if (task.runAdvice) steps.push('建议');
  return steps.length > 0 ? steps.join('·') : '未选步骤';
}

const MODE_ITEMS = [
  { value: 'daily', label: '每天固定时间' },
  { value: 'interval', label: '按间隔重复' },
];

export function SchedulesCard(props: {
  value: ScheduleTaskDraft[];
  onChange: (next: ScheduleTaskDraft[]) => void;
  /** 服务端实时计划：每个启用任务的下次运行时间。 */
  nextRuns?: ScheduleNextRun[];
  /** 初始就展开的任务 id（无头渲染/预览用；运行时默认全部收起）。 */
  defaultExpandedId?: string;
}) {
  const toast = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(props.defaultExpandedId ?? null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleTaskDraft | null>(null);
  const tasks = props.value ?? [];
  const nextById = new Map((props.nextRuns ?? []).map((entry) => [entry.id, entry.nextRunAt]));
  const enabledCount = tasks.filter((task) => task.enabled).length;

  function update(id: string, changes: Partial<ScheduleTaskDraft>) {
    props.onChange(tasks.map((task) => (task.id === id ? { ...task, ...changes } : task)));
  }

  function add() {
    if (tasks.length >= MAX_SCHEDULES) {
      toast.warn('已达上限', `最多只能配置 ${MAX_SCHEDULES} 个定时任务`);
      return;
    }
    const draft = newScheduleDraft({ name: `定时任务 ${tasks.length + 1}` });
    props.onChange([...tasks, draft]);
    setExpandedId(draft.id); // 新任务直接展开，省一次点击
    toast.success('已加入草稿', '设置好触发时间与步骤后，点击「保存设置」生效');
  }

  function remove(task: ScheduleTaskDraft) {
    props.onChange(tasks.filter((entry) => entry.id !== task.id));
    if (expandedId === task.id) setExpandedId(null);
    setDeleteTarget(null);
    toast.success('已从草稿移除', '点击「保存设置」后生效');
  }

  return (
    <Card
      title={
        <span className="center gap-2">
          AI 定时任务
          <span className="tiny mute">
            {tasks.length === 0 ? '未配置' : `${tasks.length} 个 · 启用 ${enabledCount}`}
          </span>
        </span>
      }
      actions={
        <Button size="sm" variant="primary" onClick={add} disabled={tasks.length >= MAX_SCHEDULES}>
          添加任务
        </Button>
      }
    >
      <div className="tiny mute mb-2">
        每个任务独立触发；同一时刻到期的任务会合并成一次运行（步骤取并集）。改完点「保存设置」生效。
      </div>

      {tasks.length === 0 ? (
        <div className="tiny mute">还没有定时任务。添加一个，例如「工作日 08:45 跑资产分析 + 投资建议」。</div>
      ) : (
        <div className="sched-list">
          {tasks.map((task) => {
            const open = expandedId === task.id;
            const next = nextById.get(task.id);
            return (
              <div key={task.id}>
                <div className={`sched-row${task.enabled ? '' : ' is-off'}${open ? ' is-open' : ''}`}>
                  <Checkbox
                    checked={task.enabled}
                    onChange={(checked) => update(task.id, { enabled: checked })}
                    label={<span className="tiny" title="启用该任务">启用</span>}
                  />
                  <span className="sched-name truncate" title={task.name}>
                    {task.name || '未命名任务'}
                  </span>
                  <span className="sched-meta mono">{triggerText(task)}</span>
                  <span className={`sched-steps${stepsShort(task) === '未选步骤' ? ' sched-steps-warn' : ''}`}>
                    {stepsShort(task)}
                  </span>
                  <span className="sched-spacer" />
                  <span className="sched-next">
                    {task.enabled ? (next ? `下次 ${fmtDateTime(next)}` : '下次未知') : '已停用'}
                  </span>
                  <div className="row-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${open ? '收起' : '编辑'}任务 ${task.name}`}
                      onClick={() => setExpandedId(open ? null : task.id)}
                    >
                      {open ? '收起' : '编辑'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`删除任务 ${task.name}`}
                      onClick={() => setDeleteTarget(task)}
                    >
                      删除
                    </Button>
                  </div>
                </div>

                {open && (
                  <div className="sched-editor">
                    <div className="sched-form">
                      <Field label="任务名称">
                        <Input
                          className="input-sm"
                          value={task.name}
                          onChange={(event) => update(task.id, { name: event.target.value })}
                        />
                      </Field>
                      <Field label="触发方式">
                        <Dropdown
                          size="sm"
                          ariaLabel={`触发方式：${task.name}`}
                          value={task.mode}
                          items={MODE_ITEMS}
                          onChange={(mode) => update(task.id, { mode: mode as ScheduleTaskDraft['mode'] })}
                        />
                      </Field>
                      {task.mode === 'daily' ? (
                        <Field label="每天时间（HH:mm）">
                          <Input
                            className="input-sm"
                            type="time"
                            value={task.dailyTime}
                            onChange={(event) => update(task.id, { dailyTime: event.target.value })}
                          />
                        </Field>
                      ) : (
                        <Field label="间隔（分钟）">
                          <Input
                            className="input-sm"
                            inputMode="decimal"
                            value={task.intervalMinutes}
                            onChange={(event) => update(task.id, { intervalMinutes: event.target.value })}
                          />
                        </Field>
                      )}
                    </div>

                    <div className="flex wrap center gap-3 mt-2">
                      <span className="tiny mute">要跑的步骤</span>
                      <Checkbox
                        checked={task.runAssetAnalysis}
                        onChange={(checked) => update(task.id, { runAssetAnalysis: checked })}
                        label={<span className="tiny">资产分析</span>}
                      />
                      <Checkbox
                        checked={task.runWatchlistAnalysis}
                        onChange={(checked) => update(task.id, { runWatchlistAnalysis: checked })}
                        label={<span className="tiny">标的分析</span>}
                      />
                      <Checkbox
                        checked={task.runAdvice}
                        onChange={(checked) => update(task.id, { runAdvice: checked })}
                        label={<span className="tiny">投资建议</span>}
                      />
                      <span className="tiny mute">（三个都不选无法保存）</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除定时任务"
        message={
          <span>
            确认删除定时任务 <span className="mono">{deleteTarget?.name ?? ''}</span>（
            {deleteTarget ? triggerText(deleteTarget) : ''}）？点击「保存设置」后生效。
          </span>
        }
        confirmLabel="删除"
        danger
        onConfirm={() => deleteTarget && remove(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </Card>
  );
}
