/**
 * 设置页的本地草稿模型与「只提交变更字段」的差异计算 — owner: web-ai-pages.
 *
 * 数值输入统一以字符串保存在草稿里（便于清空/编辑），保存时才解析校验；
 * `apiKey` 留空表示不下发该字段（保持服务端已存的 Key 不变）。
 */
import { DEFAULT_BUDGET, DEFAULT_DATA_SOURCES, DEFAULT_LLM, DEFAULT_OPTION_SETTINGS, DEFAULT_SCHEDULE_TASK } from '@aia/shared';
import type {
  BudgetConfig,
  DataSourceConfig,
  LlmConfig,
  OptionSettlementMode,
  Persona,
  ReportStyle,
  ScheduleMode,
  ScheduleTask,
  Settings,
  SettingsInput,
} from '@aia/shared';

/**
 * 定时任务草稿：数值字段（间隔）保持字符串便于编辑，保存时统一解析校验。
 * 每个任务都带 mode 对应的两个字段（间隔 / 时间），切换触发方式不会丢配置。
 */
export interface ScheduleTaskDraft {
  id: string;
  name: string;
  enabled: boolean;
  mode: ScheduleMode;
  intervalMinutes: string;
  dailyTime: string;
  runAssetAnalysis: boolean;
  runWatchlistAnalysis: boolean;
  /** 2026-10 新增：打新分析（刷新新股信息 + 是否申购结论）。 */
  runIpoAnalysis: boolean;
  runAdvice: boolean;
}

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
  /** 期权卖权设置（可用现金 / 到期结算模式 / 是否随建议流水线一起跑）。 */
  option: OptionDraft;
  /** AI 定时任务（数组：可并存多个，各自选触发方式与步骤）。 */
  schedules: ScheduleTaskDraft[];
}

/**
 * 期权卖权草稿。
 *
 * 现金按原币存字符串（便于清空/编辑），保存时才解析；`settlementMode` 与
 * `runWithPipeline` 是枚举/布尔，直接存值。
 */
export interface OptionDraft {
  /** 港股可用现金（HKD）。0 表示未填写：此时不会给出无法覆盖的卖 Put。 */
  cashHK: string;
  /** 美股可用现金（USD）。 */
  cashUS: string;
  settlementMode: OptionSettlementMode;
  runWithPipeline: boolean;
}

/**
 * 服务端设置 → 期权草稿。
 *
 * 服务端没返回 `option`（老版本 / 精简 payload）时回退共享默认值 —— 这是「避免保存时把
 * 期权设置重置」的第一道保险：草稿里永远有一份完整的期权设置，差异比较才有基线。
 */
export function toOptionDraft(settings: Settings): OptionDraft {
  const option = settings.option ?? DEFAULT_OPTION_SETTINGS;
  return {
    cashHK: String(option.cash?.HK ?? DEFAULT_OPTION_SETTINGS.cash.HK),
    cashUS: String(option.cash?.US ?? DEFAULT_OPTION_SETTINGS.cash.US),
    settlementMode: option.settlementMode === 'manual' ? 'manual' : 'auto',
    runWithPipeline: option.runWithPipeline !== false,
  };
}

/** 新建任务用的稳定 id（只含字母数字与下划线，服务端只接受这一组字符）。 */
export function newScheduleId(): string {
  return `sched_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 新建任务的草稿（来自共享默认模板）。 */
export function newScheduleDraft(over: Partial<ScheduleTaskDraft> = {}): ScheduleTaskDraft {
  return {
    id: newScheduleId(),
    name: DEFAULT_SCHEDULE_TASK.name,
    enabled: true,
    mode: DEFAULT_SCHEDULE_TASK.mode,
    intervalMinutes: String(DEFAULT_SCHEDULE_TASK.intervalMinutes),
    dailyTime: DEFAULT_SCHEDULE_TASK.dailyTime,
    runAssetAnalysis: DEFAULT_SCHEDULE_TASK.runAssetAnalysis,
    runWatchlistAnalysis: DEFAULT_SCHEDULE_TASK.runWatchlistAnalysis,
    runIpoAnalysis: DEFAULT_SCHEDULE_TASK.runIpoAnalysis,
    runAdvice: DEFAULT_SCHEDULE_TASK.runAdvice,
    ...over,
  };
}

/** 服务端任务 → 草稿。 */
export function toScheduleDraft(task: ScheduleTask): ScheduleTaskDraft {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled !== false,
    mode: task.mode === 'interval' ? 'interval' : 'daily',
    intervalMinutes: String(task.intervalMinutes ?? DEFAULT_SCHEDULE_TASK.intervalMinutes),
    dailyTime: task.dailyTime ?? DEFAULT_SCHEDULE_TASK.dailyTime,
    runAssetAnalysis: task.runAssetAnalysis !== false,
    runWatchlistAnalysis: task.runWatchlistAnalysis !== false,
    runIpoAnalysis: task.runIpoAnalysis !== false,
    runAdvice: task.runAdvice !== false,
  };
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
    option: toOptionDraft(settings),
    schedules: (settings.schedules ?? []).map(toScheduleDraft),
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

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 草稿任务 → 提交给服务端的任务。
 *
 * 与 mode 无关的那个字段保留原值（能解析就用，不能就用默认），这样来回切换触发方式
 * 不会把用户的配置悄悄改成默认值。校验在这里做一次，错误文案直接给用户看。
 */
export function toSchedulePayload(draft: ScheduleTaskDraft): ScheduleTask {
  const name = draft.name.trim();
  if (!name) throw new Error('定时任务必须有名称');
  if (!draft.runAssetAnalysis && !draft.runWatchlistAnalysis && !draft.runIpoAnalysis && !draft.runAdvice) {
    throw new Error(`定时任务「${name}」至少要选择一个要跑的步骤`);
  }
  const dailyTime = draft.dailyTime.trim();
  if (draft.mode === 'daily' && !TIME_RE.test(dailyTime)) {
    throw new Error(`定时任务「${name}」的每天运行时间需为 HH:mm（00:00–23:59）`);
  }
  const intervalText = draft.intervalMinutes.trim();
  const intervalValue = Number(intervalText);
  const intervalMinutes =
    draft.mode === 'interval'
      ? Math.max(1, Math.floor(parseNumber(`定时任务「${name}」的运行间隔`, draft.intervalMinutes)))
      : Number.isFinite(intervalValue) && intervalValue >= 1
        ? Math.floor(intervalValue)
        : DEFAULT_SCHEDULE_TASK.intervalMinutes;
  return {
    id: draft.id,
    name,
    enabled: draft.enabled,
    mode: draft.mode,
    intervalMinutes,
    dailyTime: TIME_RE.test(dailyTime) ? dailyTime : DEFAULT_SCHEDULE_TASK.dailyTime,
    runAssetAnalysis: draft.runAssetAnalysis,
    runWatchlistAnalysis: draft.runWatchlistAnalysis,
    runIpoAnalysis: draft.runIpoAnalysis,
    runAdvice: draft.runAdvice,
  };
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

  // 定时任务：整体替换语义 —— 只在草稿与基线不同时下发（新增/删除/改动任一任务都算）。
  if (JSON.stringify(draft.schedules) !== JSON.stringify(base.schedules)) {
    input.schedules = draft.schedules.map(toSchedulePayload);
  }

  // 期权卖权：只下发**变化的那些字段**。
  // 如果无脑整体提交 `{cash:{HK,US},settlementMode,runWithPipeline}`，一次保存就会把
  // 服务端上另一处刚改过的值覆盖回草稿里的旧值（草稿是打开页面时的快照）。
  const option: NonNullable<SettingsInput['option']> = {};
  if (draft.option.cashHK !== base.option.cashHK || draft.option.cashUS !== base.option.cashUS) {
    // 契约里的 cash 是两个市场的完整对象（Partial 与 cash 交叉后仍是必填两键），
    // 所以只要有一个市场变了就两个一起发——值都来自草稿，不会丢用户的输入。
    option.cash = {
      HK: parseNumber('港股可用现金（HKD）', draft.option.cashHK),
      US: parseNumber('美股可用现金（USD）', draft.option.cashUS),
    };
  }
  if (draft.option.settlementMode !== base.option.settlementMode) option.settlementMode = draft.option.settlementMode;
  if (draft.option.runWithPipeline !== base.option.runWithPipeline) option.runWithPipeline = draft.option.runWithPipeline;
  if (Object.keys(option).length > 0) input.option = option;

  if (draft.apiKey.trim() !== '') input.apiKey = draft.apiKey.trim();

  return input;
}

