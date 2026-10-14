/**
 * 设置页的本地草稿模型与「只提交变更字段」的差异计算 — owner: web-ai-pages.
 *
 * 数值输入统一以字符串保存在草稿里（便于清空/编辑），保存时才解析校验；
 * `apiKey` 留空表示不下发该字段（保持服务端已存的 Key 不变）。
 */
import { DEFAULT_BUDGET, DEFAULT_DATA_SOURCES, DEFAULT_LLM, DEFAULT_SCHEDULE } from '@aia/shared';
import type {
  BudgetConfig,
  DataSourceConfig,
  LlmConfig,
  Persona,
  ReportStyle,
  ScheduleConfig,
  ScheduleMode,
  Settings,
  SettingsInput,
} from '@aia/shared';

export interface Draft {
  baseUrl: string;
  model: string;
  fastModel: string;
  temperature: string;
  maxTokens: string;
  timeoutMs: string;
  /** 空字符串 = 不修改已保存的 Key。 */
  apiKey: string;
  persona: Persona;
  reportStyle: ReportStyle;
  dataSources: DataSourceConfig;
  budgetCN: string;
  budgetHK: string;
  budgetUS: string;
  enforceBudget: boolean;
  watchlistCandidateLimit: string;
  /** P3：连续确认退役多少次后自动移除标的；0 = 只标记不删除。 */
  watchlistRetireDeleteRuns: string;
  scheduleMode: ScheduleMode;
  intervalMinutes: string;
  dailyTime: string;
  runAssetAnalysis: boolean;
  runWatchlistAnalysis: boolean;
  runAdvice: boolean;
}

export function toDraft(settings: Settings): Draft {
  return {
    baseUrl: settings.llm?.baseUrl ?? '',
    model: settings.llm?.model ?? '',
    fastModel: settings.llm?.fastModel ?? '',
    temperature: String(settings.llm?.temperature ?? DEFAULT_LLM.temperature),
    maxTokens: String(settings.llm?.maxTokens ?? DEFAULT_LLM.maxTokens),
    timeoutMs: String(settings.llm?.timeoutMs ?? DEFAULT_LLM.timeoutMs),
    apiKey: '',
    persona: settings.persona,
    reportStyle: settings.reportStyle,
    dataSources: settings.dataSources ?? DEFAULT_DATA_SOURCES,
    budgetCN: String(settings.budget?.CN ?? DEFAULT_BUDGET.CN),
    budgetHK: String(settings.budget?.HK ?? DEFAULT_BUDGET.HK),
    budgetUS: String(settings.budget?.US ?? DEFAULT_BUDGET.US),
    enforceBudget: settings.enforceBudget,
    watchlistCandidateLimit: String(settings.watchlistCandidateLimit ?? 5),
    watchlistRetireDeleteRuns: String(settings.watchlistRetireDeleteRuns ?? 3),
    scheduleMode: settings.schedule?.mode ?? DEFAULT_SCHEDULE.mode,
    intervalMinutes: String(settings.schedule?.intervalMinutes ?? DEFAULT_SCHEDULE.intervalMinutes),
    dailyTime: settings.schedule?.dailyTime ?? DEFAULT_SCHEDULE.dailyTime,
    runAssetAnalysis: settings.schedule?.runAssetAnalysis ?? true,
    runWatchlistAnalysis: settings.schedule?.runWatchlistAnalysis ?? true,
    runAdvice: settings.schedule?.runAdvice ?? true,
  };
}

function comparable(draft: Draft): string {
  const clone: Record<string, unknown> = { ...draft };
  delete clone.apiKey;
  return JSON.stringify(clone);
}

/** 是否与服务端已保存的设置存在差异（新填的 API Key 也算修改）。 */
export function isDirty(draft: Draft, base: Draft | null): boolean {
  if (!base) return false;
  if (draft.apiKey.trim() !== '') return true;
  return comparable(draft) !== comparable(base);
}

function parseNumber(label: string, text: string): number {
  const value = Number(text.trim());
  if (!text.trim() || !Number.isFinite(value)) throw new Error(`${label}必须是有效数字`);
  return value;
}

/** 构造 SettingsInput：只包含发生变化的字段。 */
export function buildInput(draft: Draft, base: Draft): SettingsInput {
  const input: SettingsInput = {};

  const llm: Partial<LlmConfig> = {};
  if (draft.baseUrl !== base.baseUrl) llm.baseUrl = draft.baseUrl.trim();
  if (draft.model !== base.model) llm.model = draft.model.trim();
  if (draft.fastModel !== base.fastModel) llm.fastModel = draft.fastModel.trim();
  if (draft.temperature !== base.temperature) llm.temperature = parseNumber('temperature', draft.temperature);
  if (draft.maxTokens !== base.maxTokens) llm.maxTokens = parseNumber('maxTokens', draft.maxTokens);
  if (draft.timeoutMs !== base.timeoutMs) llm.timeoutMs = parseNumber('timeoutMs', draft.timeoutMs);
  if (Object.keys(llm).length > 0) input.llm = llm;

  if (draft.persona !== base.persona) input.persona = draft.persona;
  if (draft.reportStyle !== base.reportStyle) input.reportStyle = draft.reportStyle;
  if (JSON.stringify(draft.dataSources) !== JSON.stringify(base.dataSources)) input.dataSources = draft.dataSources;

  const budget: Partial<BudgetConfig> = {};
  if (draft.budgetCN !== base.budgetCN) budget.CN = parseNumber('A股预算', draft.budgetCN);
  if (draft.budgetHK !== base.budgetHK) budget.HK = parseNumber('港股预算', draft.budgetHK);
  if (draft.budgetUS !== base.budgetUS) budget.US = parseNumber('美股预算', draft.budgetUS);
  if (Object.keys(budget).length > 0) input.budget = budget;

  if (draft.enforceBudget !== base.enforceBudget) input.enforceBudget = draft.enforceBudget;
  if (draft.watchlistCandidateLimit !== base.watchlistCandidateLimit) {
    input.watchlistCandidateLimit = parseNumber('每次候选数量上限', draft.watchlistCandidateLimit);
  }
  if (draft.watchlistRetireDeleteRuns !== base.watchlistRetireDeleteRuns) {
    input.watchlistRetireDeleteRuns = parseNumber('淘汰确认次数', draft.watchlistRetireDeleteRuns);
  }

  const schedule: Partial<ScheduleConfig> = {};
  if (draft.scheduleMode !== base.scheduleMode) schedule.mode = draft.scheduleMode;
  if (draft.intervalMinutes !== base.intervalMinutes) schedule.intervalMinutes = parseNumber('运行间隔', draft.intervalMinutes);
  if (draft.dailyTime !== base.dailyTime) schedule.dailyTime = draft.dailyTime.trim();
  if (draft.runAssetAnalysis !== base.runAssetAnalysis) schedule.runAssetAnalysis = draft.runAssetAnalysis;
  if (draft.runWatchlistAnalysis !== base.runWatchlistAnalysis) schedule.runWatchlistAnalysis = draft.runWatchlistAnalysis;
  if (draft.runAdvice !== base.runAdvice) schedule.runAdvice = draft.runAdvice;
  if (Object.keys(schedule).length > 0) input.schedule = schedule;

  if (draft.apiKey.trim() !== '') input.apiKey = draft.apiKey.trim();

  return input;
}
