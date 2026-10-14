/**
 * Monthly budget accounting (docs/API.md §6).
 *
 * **Single source of truth**: the numbers come from
 * `services/portfolio.ts#computeBudgetStatus` (owned by server-core, also used by
 * `/api/budget` and `/api/advice`), so the agent's buy gate can never disagree
 * with the UI. The only thing added here is the `enforceBudget` switch
 * (docs/API.md §2: "Whether budget enforcement blocks new buy advice").
 *
 * Rule recap: `spent = buys − sells`, `remaining = budget − buys + sells`
 * (clamped at 0 for display), per natural month and per market currency.
 *
 * Owner: agent-engine.
 */
import { localMonth } from '../db/util.js';
import { computeBudgetStatus as computePortfolioBudget } from '../services/portfolio.js';
import type { BudgetStatus, MarketBudgetStatus } from '@aia/shared';
import type { Repo } from '../types/repo.js';

/** Budget status for the current month, honouring `settings.enforceBudget`. */
export function computeBudgetStatus(repo: Repo): BudgetStatus {
  try {
    const settings = repo.getSettings();
    const status = computePortfolioBudget(repo.listAssets(), repo.listTransactions(), settings.budget, localMonth());
    if (settings.enforceBudget === false) {
      return {
        ...status,
        markets: status.markets.map((market) => ({ ...market, exhausted: false })),
      };
    }
    return status;
  } catch {
    return { month: localMonth(), markets: [] };
  }
}

/** Human-readable market label for prompts/tool output. */
export function budgetLine(status: MarketBudgetStatus): string {
  const state = status.exhausted ? '预算已用尽（禁止买入）' : '可买入';
  const spentNote = status.spent < 0 ? '净卖出' : '已用';
  return `${status.market}：预算 ${status.budget} ${status.currency}，${spentNote} ${status.spent}，剩余 ${status.remaining}（${state}）`;
}
