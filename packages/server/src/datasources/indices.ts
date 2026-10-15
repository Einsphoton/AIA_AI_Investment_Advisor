/**
 * 全球指数快照 — 东财 `push2` 为主源，腾讯行情为兜底。
 *
 * 为什么单独一个模块：调用方有两个，`registry.getIndices()`（首页 / 仪表盘）
 * 与 `macro.macroBundle()`（`get_macro` 工具）。而 `registry.ts` 已经 import
 * `macro.ts`，macro 再反向 import registry 会成循环依赖 —— 所以把「取指数 +
 * 降级」这段共享逻辑放在这里，两边都 import 它。
 *
 * 背景（用户反馈）：宏观看板报「全球指数快照不可用」，首页却同屏显示着指数 ——
 * 原因是 `macroBundle()` 直接调底层 `emIndices()`，绕过了 registry 里那层腾讯
 * 兜底；而 `emIndices()` 走 `tryJson`，上游 502 / 超时被吞成空数组，warning 里
 * 连失败原因都没有。现在两条路径共用同一份带兜底与原因的实现。
 *
 * Owner: agent-engine.
 */
import type { Quote } from '@aia/shared';
import { emIndices } from './eastmoney.js';
import { errorMessage } from './http.js';
import { tencentBatch } from './tencent.js';
import type { Sourced } from './types.js';

/** 腾讯行情的指数代码（`sh000001` 形式），与 registry 原本的兜底列表一致。 */
const TENCENT_INDEX_SYMBOLS = ['sh000001', 'sz399001', 'hkHSI', 'usDJI', 'usIXIC', 'usINX'];

/**
 * 全球指数：东财优先，失败降级腾讯。
 *
 * 永不抛出：`value` 为空数组时 `warnings` 一定带上了两家的真实失败原因
 * （HTTP 状态 / 超时 / 连接重置），可直接写进工具返回与诊断报告。
 */
export async function globalIndices(): Promise<Sourced<Quote[]>> {
  const warnings: string[] = [];

  try {
    const quotes = await emIndices((message) => warnings.push(`东方财富指数请求失败：${message}`));
    if (quotes.length > 0) return { value: quotes, sources: ['eastmoney'], warnings };
    warnings.push('东方财富指数快照为空');
  } catch (error) {
    warnings.push(`东方财富指数失败：${errorMessage(error)}`);
  }

  try {
    const quotes = await tencentBatch(TENCENT_INDEX_SYMBOLS, (symbol) =>
      symbol.startsWith('hk') ? 'HK' : symbol.startsWith('us') ? 'US' : 'CN',
    );
    if (quotes.length > 0) return { value: quotes, sources: ['tencent'], warnings };
    warnings.push('腾讯指数快照为空');
  } catch (error) {
    warnings.push(`腾讯指数失败：${errorMessage(error)}`);
  }

  return { value: [], sources: [], warnings };
}
