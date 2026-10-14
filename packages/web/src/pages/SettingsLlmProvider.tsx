/**
 * AI 配置的「供应商预设」下拉 — owner: web-ai-pages.
 *
 * 只负责「选一个常用厂商 → 填 Base URL / 推荐模型 / 快速模型」这一步：
 * - 选中项由当前 `baseUrl` 反查预设得出，用户手动改地址后会退回「自定义」，不会锁死；
 * - 显式选「自定义」只切换下拉显示，不改写任何输入框；
 * - API Key 从不自动填充或清空（服务端永远不回显明文）。
 */
import { useEffect, useMemo, useState } from 'react';
import { LLM_PROVIDER_CUSTOM_ID, LLM_PROVIDER_PRESETS, matchLlmProviderPreset } from '@aia/shared';
import type { LlmProviderPreset } from '@aia/shared';
import { Dropdown, Field } from '../components/ui';
import type { DropdownItem } from '../components/ui';

const REGION_ORDER: LlmProviderPreset['region'][] = ['cn', 'global', 'gateway', 'local'];

const REGION_LABELS: Record<LlmProviderPreset['region'], string> = {
  cn: '国内厂商',
  global: '国际厂商',
  gateway: '聚合网关 / 中转（一个 Key 多用）',
  local: '本地推理（Key 可用占位值）',
};

export function LlmProviderField(props: {
  /** 当前草稿里的 Base URL，用于反查已选预设。 */
  baseUrl: string;
  /** 用户选择某个预设：由父组件写入 Base URL 与推荐模型。 */
  onPick: (preset: LlmProviderPreset) => void;
}) {
  const matched = matchLlmProviderPreset(props.baseUrl);
  const derived = matched?.id ?? LLM_PROVIDER_CUSTOM_ID;
  /** 用户显式点选的项；`baseUrl` 变了就作废，回到反查结果。 */
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? derived;
  const active = matched;

  // Base URL 被改成别的预设（或手动改乱）时，下拉要跟着走；只选「自定义」不改地址，
  // 因此 derived 不变、本效果不重跑，这种显式选择不会被覆盖。
  useEffect(() => {
    setPicked(null);
  }, [derived]);

  // 分组顺序固定：国内 / 国际 / 聚合网关 / 本地推理；自定义永远排在最前。
  const items = useMemo<DropdownItem[]>(() => {
    const groups: DropdownItem[] = [
      { value: LLM_PROVIDER_CUSTOM_ID, label: '自定义（手动填写 Base URL）' },
    ];
    for (const region of REGION_ORDER) {
      const group = LLM_PROVIDER_PRESETS.filter((preset) => preset.region === region);
      if (group.length === 0) continue;
      groups.push({
        group: REGION_LABELS[region],
        options: group.map((preset) => ({ value: preset.id, label: preset.label })),
      });
    }
    return groups;
  }, []);

  function change(id: string) {
    setPicked(id);
    const preset = LLM_PROVIDER_PRESETS.find((entry) => entry.id === id);
    if (preset) props.onPick(preset);
  }

  return (
    <Field
      label="供应商预设"
      className="span-2"
      hint={
        active ? (
          <>
            {active.notes}{' '}
            <a href={active.docsUrl} target="_blank" rel="noreferrer">
              申请 / 查看 API Key ↗
            </a>
          </>
        ) : (
          '选择常用厂商会自动填入 Base URL 与推荐模型（模型名可手动修改）；也可选择「自定义」填写任意 OpenAI 兼容地址。'
        )
      }
    >
      <Dropdown value={selected} ariaLabel="LLM 供应商预设" items={items} onChange={change} />
    </Field>
  );
}
