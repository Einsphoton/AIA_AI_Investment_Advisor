/**
 * @aia/shared — runtime constants shared by server and web.
 * Keep this file dependency-free so it can be bundled anywhere.
 */
import type {
  BarInterval,
  BudgetConfig,
  DataSourceCatalogueEntry,
  DataSourceConfig,
  InstrumentType,
  LlmConfig,
  Market,
  McpServerConfig,
  Persona,
  RangeKey,
  ReportStyle,
  ScheduleConfig,
  ToolPolicy,
} from './types.js';

export const APP_VERSION = '0.1.0';

/* ───────────────────────────────── markets ────────────────────────────────── */

export const MARKETS: Market[] = ['CN', 'HK', 'US'];

export const MARKET_LABELS: Record<Market, string> = {
  CN: 'A股',
  HK: '港股',
  US: '美股',
};

export const MARKET_CURRENCY: Record<Market, string> = {
  CN: 'CNY',
  HK: 'HKD',
  US: 'USD',
};

export const MARKET_CURRENCY_SYMBOL: Record<Market, string> = {
  CN: '¥',
  HK: 'HK$',
  US: '$',
};

export const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥',
  RMB: '¥',
  HKD: 'HK$',
  USD: '$',
};

export const INSTRUMENT_TYPES: InstrumentType[] = ['stock', 'etf', 'fund'];

export const INSTRUMENT_TYPE_LABELS: Record<InstrumentType, string> = {
  stock: '股票',
  etf: '场内基金',
  fund: '场外基金',
};

/** Fallback FX rates into CNY; live rates override these when reachable. */
export const FX_FALLBACK_INTO_CNY: Record<string, number> = {
  CNY: 1,
  HKD: 0.92,
  USD: 7.1,
};

/* ──────────────────────────────── personas ───────────────────────────────── */

export interface PersonaPreset {
  id: Persona;
  label: string;
  description: string;
  riskLevel: number;
  horizon: string;
  /** Guidance injected into the agent system prompt. */
  guidance: string;
  /** Default quality-score gate the agent applies to new candidates. */
  qualityGate: number;
}

export const PERSONAS: PersonaPreset[] = [
  {
    id: 'steady',
    label: '稳健型',
    description: '优先保本，接受较低收益，回避高波动与高估值标的。',
    riskLevel: 1,
    horizon: '1-3 年',
    guidance:
      '偏好行业龙头、现金流稳定、负债率低、股息稳定的公司；回避概念股、次新股与高杠杆企业；单只标的建议仓位不超过 15%；回撤容忍度低，估值分位高于 70% 时应给出减仓提示。',
    qualityGate: 70,
  },
  {
    id: 'aggressive',
    label: '激进型',
    description: '追求高弹性收益，可承受较大回撤，关注成长与主题机会。',
    riskLevel: 5,
    horizon: '6 个月 - 2 年',
    guidance:
      '可关注高成长赛道、景气度反转与主题机会；允许参与高波动标的，但必须给出明确的风险与止损参考位；单只标的仓位上限 25%；优先追问催化剂与业绩兑现节奏。',
    qualityGate: 55,
  },
  {
    id: 'value',
    label: '价值型',
    description: '以内在价值与安全边际为核心，长期持有被低估的优质资产。',
    riskLevel: 3,
    horizon: '3 年以上',
    guidance:
      '以自由现金流折现、ROE 持续性、护城河、管理层资本配置能力为核心判断依据；重点比较 PE/PB/PS 的历史分位与同业分位；只在明显低估（安全边际 > 20%）时给出买入建议；不因短期波动卖出。',
    qualityGate: 65,
  },
  {
    id: 'income',
    label: '収息型',
    description: '重视现金分红与分红可持续性，追求稳定现金流。',
    riskLevel: 2,
    horizon: '2-5 年',
    guidance:
      '核心筛选股息率、分红率、自由现金流覆盖倍数与分红连续性；股息率低于 3% 或分红率超过 80% 且现金流不匹配时降级；关注利率与税费影响，优先红利指数成分与公用事业、银行、能源类资产。',
    qualityGate: 68,
  },
  {
    id: 'balanced',
    label: '均衡型',
    description: '股债与行业均衡配置，兼顾成长与价值，控制组合波动。',
    riskLevel: 3,
    horizon: '1-3 年',
    guidance:
      '关注行业分散度与相关性，避免组合在单一行业上超过 30%；同时评估价值与成长两类机会；给建议时需说明它在组合中扮演的角色（进攻/防守/对冲）。',
    qualityGate: 62,
  },
  {
    id: 'shortterm',
    label: '短线交易型',
    description: '以技术面与资金面为主，持仓周期短，重视流动性与量价配合。',
    riskLevel: 4,
    horizon: '1 天 - 4 周',
    guidance:
      '以趋势、量能、资金流向、换手率、关键支撑压力位为主要依据；必须给出明确入场价、止盈价与止损价；回避流动性差的标的（日均成交额低于 5000 万）；消息面只作为催化剂，不作唯一依据。',
    qualityGate: 50,
  },
];

export const PERSONA_MAP: Record<Persona, PersonaPreset> = Object.fromEntries(
  PERSONAS.map((p) => [p.id, p]),
) as Record<Persona, PersonaPreset>;

/* ────────────────────────────── report styles ─────────────────────────────── */

export interface ReportStylePreset {
  id: ReportStyle;
  label: string;
  description: string;
  guidance: string;
}

export const REPORT_STYLES: ReportStylePreset[] = [
  {
    id: 'professional',
    label: '专业型',
    description: '可使用专业术语，结论密集，适合有投资经验的用户。',
    guidance:
      '可以使用 PE/PB/ROIC、自由现金流、久期、贝塔、估值分位等专业术语，无需解释基本概念；结论先行，论据紧凑，允许使用表格化要点。',
  },
  {
    id: 'beginner',
    label: '新手型',
    description: '用通俗语言解释，先讲结论再讲原因，避免堆砌术语。',
    guidance:
      '避免堆砌术语，出现专业名词时必须用一句大白话解释；多用类比和生活化表达；先给结论，再给 3 条以内的理由；明确提示风险与不确定性。',
  },
];

export const REPORT_STYLE_MAP: Record<ReportStyle, ReportStylePreset> = Object.fromEntries(
  REPORT_STYLES.map((s) => [s.id, s]),
) as Record<ReportStyle, ReportStylePreset>;

/* ─────────────────────────────── chart ranges ────────────────────────────── */

export const RANGE_KEYS: RangeKey[] = ['1m', '3m', '6m', '1y', '3y', '5y', 'max'];

export const RANGE_LABELS: Record<RangeKey, string> = {
  '1m': '1月',
  '3m': '3月',
  '6m': '6月',
  '1y': '1年',
  '3y': '3年',
  '5y': '5年',
  max: '全部',
};

/** Trading-day lookback used when slicing series. */
export const RANGE_DAYS: Record<RangeKey, number> = {
  '1m': 31,
  '3m': 93,
  '6m': 186,
  '1y': 366,
  '3y': 1096,
  '5y': 1827,
  max: 36500,
};

export const BAR_INTERVALS: BarInterval[] = ['day', 'week', 'month'];

export const BAR_INTERVAL_LABELS: Record<BarInterval, string> = {
  day: '日K',
  week: '周K',
  month: '月K',
};

/* ──────────────────────────────── defaults ───────────────────────────────── */

export const DEFAULT_LLM: LlmConfig = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-flash',
  /** 0.3 keeps analysis reproducible; it is a randomness knob, not a "smartness" one. */
  temperature: 0.3,
  /**
   * Output cap, not a capability knob. 4096 truncated long reports (and
   * thinking models count their reasoning toward it), so the default leaves
   * room while staying well under every provider's limit.
   */
  maxTokens: 8192,
  fastModel: '',
  timeoutMs: 180_000,
  /** Conservative default: leaves headroom for maxTokens + tool schemas. */
  contextTokens: 48_000,
};

/* ──────────────────────── LLM provider presets (AI 配置) ──────────────────── */

/**
 * 常用 LLM 供应商预设，用于设置页「AI 配置」的一键填充。
 *
 * 收录范围：提供 **OpenAI 兼容 `chat/completions`** 的厂商 —— 服务端统一用
 * `POST {baseUrl}/chat/completions` + `Authorization: Bearer <key>` 调用
 * （见 `packages/server/src/agent/llm.ts`），因此非兼容协议（如 Anthropic 原生
 * `/v1/messages`）不在此列，需要走 OpenRouter 之类的兼容网关。
 *
 * `model` / `fastModel` 只是**建议值**，各厂商模型名会不定期更新，界面上可手动改写；
 * 空字符串表示该厂商的模型名必须由用户自行填写（如火山方舟的接入点 ID、vLLM 加载名），
 * 选择该预设时会清空对应输入框以便填写。
 */
export interface LlmProviderPreset {
  id: string;
  label: string;
  /** 用于下拉分组：国内 / 国际 / 聚合网关 / 本地推理。 */
  region: 'cn' | 'global' | 'gateway' | 'local';
  /** OpenAI 兼容根地址（不要带 `/chat/completions`）。 */
  baseUrl: string;
  /**
   * 同一供应商的其它官方等价 Base URL。用于按地址回显预设：用户手填了官方的另一种
   * 写法（例如 OpenCode 的 `/inference/openai/v1` 与 `/inference/go/openai/v1`）时，
   * 下拉仍能选中对应预设并显示排障说明，而不是退化成「自定义」。
   */
  aliases?: string[];
  /** 建议的主模型名；空串 = 该厂商需手动填写（选择预设时清空）。 */
  model: string;
  /** 建议的轻量模型名；空串 = 清空（界面上留空即复用主模型）。 */
  fastModel: string;
  /** 厂商侧是否需要 API Key（本地推理服务为 false）。 */
  keyRequired: boolean;
  notes: string;
  /** 申请 Key / 查看文档的官方地址。 */
  docsUrl: string;
}

export const LLM_PROVIDER_PRESETS: LlmProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    region: 'cn',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-pro',
    fastModel: 'deepseek-flash',
    keyRequired: true,
    notes: '默认供应商。现行型号：deepseek-v4-pro（推理更强）与 deepseek-flash（V4.1-Flash，快且便宜，1M 上下文）；旧 deepseek-chat 已下线。官方 base 为 https://api.deepseek.com，带 /v1 亦可。',
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi（国内站）',
    region: 'cn',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k3',
    fastModel: 'kimi-k2.6',
    keyRequired: true,
    notes: 'Kimi K3（1M 上下文）为主力，kimi-k2.6 更便宜。注意 K3 的 temperature 固定为 1.0、不能显式传入，如报参数错误请改用 kimi-k2.6；控制台已迁至 platform.kimi.com。',
    docsUrl: 'https://platform.kimi.com/docs/get-api-key',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    region: 'cn',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.3',
    fastModel: 'glm-5.3-flash',
    keyRequired: true,
    notes: 'GLM-5 系列（glm-5.3 / glm-5.3-flash）；GLM-4 系列为历史型号。',
    docsUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    region: 'cn',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    fastModel: 'qwen3.7-plus',
    keyRequired: true,
    notes: '务必使用「兼容模式」路径（compatible-mode，原生 DashScope 协议不兼容）；qwen3.8-max 能力最强，qwen3.7-plus 性价比高。官方后续推荐改用业务空间专属域名，旧域名仍可用。',
    docsUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    region: 'cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '一个 Key 切换多家开源模型；模型名形如「组织/模型」，完整版需加 Pro/ 前缀（如 Pro/deepseek-ai/DeepSeek-R1），请以控制台模型广场为准。',
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'volcengine',
    label: '火山方舟（豆包）',
    region: 'cn',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '「模型」处需填写在方舟控制台创建的推理接入点 ID（形如 ep-2024…），不是模型名；选择本预设会清空该字段，请自行粘贴。',
    docsUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    region: 'global',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6.1-sol',
    fastModel: 'gpt-6-luna',
    keyRequired: true,
    notes: '官方直连在国内网络下通常不可达；可用 OpenRouter / OpenCode 等网关替代。当前门面型号：gpt-6-astra（旗舰）/ gpt-6.1-sol（均衡）/ gpt-6-luna（低成本高并发）。',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合网关）',
    region: 'gateway',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '~openai/gpt-sol-latest',
    fastModel: '~anthropic/claude-sonnet-latest',
    keyRequired: true,
    notes: '一个 Key 访问多家模型；模型名形如「厂商/模型」，以 ~ 开头的别名会自动跟随该家族最新版（如 ~openai/gpt-sol-latest）。',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq',
    label: 'Groq（高速推理）',
    region: 'global',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '主打低延迟开源模型托管，适合摘要等轻量任务；模型名请从 console.groq.com 的 Models 页复制。',
    docsUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    region: 'global',
    baseUrl: 'https://api.x.ai/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: 'Grok 系列（当前为 4.x/5.x 代际）；模型名请从 console.x.ai 复制后填入，以控制台为准。',
    docsUrl: 'https://console.x.ai/',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    region: 'global',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    fastModel: 'mistral-small-latest',
    keyRequired: true,
    notes: '使用 *-latest 别名可自动跟随官方最新版本。',
    docsUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'together',
    label: 'Together AI',
    region: 'global',
    baseUrl: 'https://api.together.xyz/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '托管开源模型；模型名区分大小写、需与平台上架名称一致，请从控制台复制（可能随版本更新）。',
    docsUrl: 'https://api.together.xyz/settings/api-keys',
  },
  {
    id: 'ollama',
    label: '本地 Ollama',
    region: 'local',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    fastModel: 'qwen2.5:3b',
    keyRequired: false,
    notes: '需先 ollama pull 对应模型（模型名以本地实际拉取的 tag 为准）。厂商不需要 Key，但本应用要求 Key 非空才会启用 AI，填任意占位值（如 ollama）即可。',
    docsUrl: 'https://ollama.com/download',
  },
  {
    id: 'vllm',
    label: '本地 vLLM / OpenAI 兼容服务',
    region: 'local',
    baseUrl: 'http://localhost:8000/v1',
    model: '',
    fastModel: '',
    keyRequired: false,
    notes: 'vLLM、SGLang、Xinference 等自建服务通用；模型名填服务实际加载的名称，Key 填任意占位值。',
    docsUrl: 'https://docs.vllm.ai/',
  },
  {
    id: 'lmstudio',
    label: '本地 LM Studio',
    region: 'local',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    fastModel: 'local-model',
    keyRequired: false,
    notes: '需在 LM Studio 中开启 Local Server；模型名以界面显示为准，Key 填任意占位值。',
    docsUrl: 'https://lmstudio.ai/docs/app/api',
  },
  /* ── 国内厂商（补充） ───────────────────────────────────────────────── */
  {
    id: 'baidu-qianfan',
    label: '百度千帆（文心一言）',
    region: 'cn',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '千帆 V2 的 OpenAI 兼容地址；模型名请从控制台的推理服务复制（ernie 系列）。',
    docsUrl: 'https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    region: 'cn',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbos-latest',
    fastModel: '',
    keyRequired: true,
    notes: '官方文档确认 /v1/chat/completions；需先在控制台开通。腾讯公告混元将逐步迁移到 TokenHub，届时地址可能变化。',
    docsUrl: 'https://console.cloud.tencent.com/hunyuan/start',
  },
  {
    id: 'spark',
    label: '讯飞星火',
    region: 'cn',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    model: '4.0Ultra',
    fastModel: 'lite',
    keyRequired: true,
    notes: '必须用 HTTP 兼容地址（WebSocket 地址不兼容）；API Key 填控制台的 APIPassword。模型名不是常规命名：4.0Ultra / lite / generalv3.5。',
    docsUrl: 'https://www.xfyun.cn/doc/spark/HTTP%E8%B0%83%E7%94%A8%E6%96%87%E6%A1%A3.html',
  },
  {
    id: 'minimax',
    label: 'MiniMax（稀宇科技）',
    region: 'cn',
    baseUrl: 'https://api.minimax.cn/v1',
    model: 'MiniMax-M3',
    fastModel: 'MiniMax-M2.7-highspeed',
    keyRequired: true,
    notes: '国内域名已改为 api.minimax.cn；主力型号 MiniMax-M3。M2.5/M2.7 系列自 2026-11-18 起下线，若报模型不存在请改用 M3。',
    docsUrl: 'https://platform.minimax.cn/docs/api-reference/text-chat-openai',
  },
  {
    id: 'stepfun',
    label: '阶跃星辰 StepFun',
    region: 'cn',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-5-preview',
    fastModel: 'step-3.5-flash',
    keyRequired: true,
    notes: '官方给出 OpenAI SDK 用法；step-5-preview 为预览版主力，step-3.5-flash 轻量。',
    docsUrl: 'https://platform.stepfun.com/interface-key',
  },
  {
    id: 'sensenova',
    label: '商汤日日新 SenseNova',
    region: 'cn',
    baseUrl: 'https://api.sensenova.cn/compatible-mode/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '需使用「兼容模式」地址；模型名填控制台可用型号。',
    docsUrl: 'https://console.sensecore.cn/',
  },
  {
    id: 'lingyiwanwu',
    label: '零一万物 01.AI',
    region: 'cn',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: 'OpenAI 兼容地址；模型名填控制台型号（yi 系列）。',
    docsUrl: 'https://platform.lingyiwanwu.com/apikeys',
  },
  {
    id: 'baichuan',
    label: '百川智能',
    region: 'cn',
    baseUrl: 'https://api.baichuan-ai.com/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: 'OpenAI 兼容地址；模型名填控制台型号（Baichuan 系列）。',
    docsUrl: 'https://platform.baichuan-ai.com/console/apikey',
  },
  {
    id: 'modelscope',
    label: 'ModelScope 魔搭社区',
    region: 'cn',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '魔搭的 OpenAI 兼容推理入口；模型名形如「组织/模型」，需具备对应模型的访问授权。',
    docsUrl: 'https://modelscope.cn/my/myaccesstoken',
  },
  {
    id: 'infini',
    label: '无问芯穹 Infini',
    region: 'cn',
    baseUrl: 'https://cloud.infini-ai.com/maas/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: 'Maas 平台的 OpenAI 兼容地址；模型名填平台上架名称。',
    docsUrl: 'https://cloud.infini-ai.com/platform/ai',
  },
  {
    id: 'ppio',
    label: 'PPIO 派欧云',
    region: 'cn',
    baseUrl: 'https://api.ppinfra.com/v3/openai',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '注意地址含 /v3/openai 前缀；模型名填平台上架名称。',
    docsUrl: 'https://ppio.com/',
  },
  {
    id: 'longcat',
    label: '美团 LongCat',
    region: 'cn',
    baseUrl: 'https://api.longcat.chat/openai/v1',
    model: 'LongCat-2.5-Preview',
    fastModel: 'LongCat-2.0',
    keyRequired: true,
    notes: '官方 endpoint 写 /openai，curl 完整路径为 /openai/v1/chat/completions；本应用会拼成 /openai/v1/chat/completions。',
    docsUrl: 'https://longcat.chat/platform/api_keys',
  },
  /* ── 国际厂商（补充） ───────────────────────────────────────────────── */
  {
    id: 'anthropic',
    label: 'Anthropic Claude（OpenAI 兼容层）',
    region: 'global',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-5',
    fastModel: 'claude-haiku-4-5',
    keyRequired: true,
    notes: 'Anthropic 的 OpenAI SDK 兼容端点（/v1/chat/completions），只覆盖基础对话能力；官方文档域在部分网络下无法直连，若调用失败可改用 OpenRouter / OpenCode 等网关。',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'gemini',
    label: 'Google Gemini（OpenAI 兼容）',
    region: 'global',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    fastModel: 'gemini-3.5-flash-lite',
    keyRequired: true,
    notes: 'Google 官方 OpenAI 兼容地址（即 .../v1beta/openai/chat/completions）；模型如 gemini-3.8-flash、gemini-3.1-pro。',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'perplexity',
    label: 'Perplexity（联网检索模型）',
    region: 'global',
    baseUrl: 'https://api.perplexity.ai',
    model: 'sonar-pro',
    fastModel: 'sonar',
    keyRequired: true,
    notes: '注意根地址不带 /v1；模型自带联网检索，适合资讯类分析。',
    docsUrl: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'cohere',
    label: 'Cohere（兼容层）',
    region: 'global',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    model: 'command-a-plus-05-2026',
    fastModel: 'command-r7b-12-2024',
    keyRequired: true,
    notes: '使用 compatibility 兼容端点（注意不是 /v1）；command-a 为当前主力，command-r7b 为轻量型号。',
    docsUrl: 'https://dashboard.cohere.com/api-keys',
  },
  {
    id: 'deepinfra',
    label: 'DeepInfra',
    region: 'global',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    fastModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    keyRequired: true,
    notes: '根地址是 /v1/openai（不是 /v1）；模型名形如「组织/模型」，其余型号见 deepinfra.com/models。',
    docsUrl: 'https://deepinfra.com/dash',
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    region: 'global',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/kimi-k3',
    fastModel: 'accounts/fireworks/models/glm-5p3-flash',
    keyRequired: true,
    notes: 'OpenAI 兼容根地址含 /inference/v1；模型 ID 必须写全路径 accounts/fireworks/models/<slug>。',
    docsUrl: 'https://fireworks.ai/account/api-keys',
  },
  {
    id: 'cerebras',
    label: 'Cerebras（超低延迟推理）',
    region: 'global',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    fastModel: 'qwen-3.8-27b',
    keyRequired: true,
    notes: '以极低延迟著称；Shared Inference 当前主要提供 gpt-oss-120b 与 qwen-3.8-27b。',
    docsUrl: 'https://cloud.cerebras.ai/',
  },
  {
    id: 'sambanova',
    label: 'SambaNova Cloud',
    region: 'global',
    baseUrl: 'https://api.sambanova.ai/v1',
    model: 'Meta-Llama-3.3-70B-Instruct',
    fastModel: 'gpt-oss-120b',
    keyRequired: true,
    notes: '模型 ID 大小写敏感，需与平台一致；另支持 /v1/responses。',
    docsUrl: 'https://cloud.sambanova.ai/apis',
  },
  {
    id: 'nebius',
    label: 'Nebius Token Factory（原 AI Studio）',
    region: 'global',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    model: 'deepseek-ai/DeepSeek-R1-0528',
    fastModel: 'deepseek-ai/DeepSeek-R1-0528-fast',
    keyRequired: true,
    notes: '原 Nebius AI Studio 已更名 Token Factory，旧域名会重定向；模型名形如「组织/模型」，-fast 为低延迟版本。',
    docsUrl: 'https://tokenfactory.nebius.com/',
  },
  {
    id: 'novita',
    label: 'Novita AI',
    region: 'global',
    baseUrl: 'https://api.novita.ai/openai/v1',
    model: 'deepseek/deepseek-v4-pro',
    fastModel: 'deepseek/deepseek-v4.1-flash',
    keyRequired: true,
    notes: '根地址为 /openai/v1（本应用会拼成 /openai/v1/chat/completions）；模型名形如「厂商/模型」。',
    docsUrl: 'https://novita.ai/console',
  },
  {
    id: 'chutes',
    label: 'Chutes',
    region: 'global',
    baseUrl: 'https://llm.chutes.ai/v1',
    model: 'moonshotai/Kimi-K2.6-TEE',
    fastModel: 'google/gemma-4-31B-turbo-TEE',
    keyRequired: true,
    notes: 'OpenAI 协议（/v1/chat/completions）；模型名形如「厂商/模型-TEE」，TEE 为可信执行环境版本。',
    docsUrl: 'https://chutes.ai/signup',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face Inference Providers',
    region: 'global',
    baseUrl: 'https://router.huggingface.co/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: 'HF 路由器统一入口；模型名形如「组织/模型:provider」，使用 HF Token（含免费额度）。',
    docsUrl: 'https://huggingface.co/settings/tokens',
  },
  {
    id: 'vercel-gateway',
    label: 'Vercel AI Gateway',
    region: 'global',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    model: 'openai/gpt-6-astra',
    fastModel: 'anthropic/claude-sonnet-5',
    keyRequired: true,
    notes: '模型名形如「厂商/模型」，可用 GET https://ai-gateway.vercel.sh/v1/models 免鉴权查看完整清单。',
    docsUrl: 'https://vercel.com/docs/ai-gateway/authentication-and-byok/api-keys',
  },
  {
    id: 'zai',
    label: '智谱 Z.AI（国际站）',
    region: 'global',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.3',
    fastModel: 'glm-5.3-flash',
    keyRequired: true,
    notes: '智谱国际站，协议与国内站一致；适合海外网络。',
    docsUrl: 'https://z.ai/manage-apikey/apikey-list',
  },
  {
    id: 'moonshot-intl',
    label: '月之暗面 Kimi（国际站）',
    region: 'global',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
    fastModel: 'kimi-k2.6',
    keyRequired: true,
    notes: '国际站域名 api.moonshot.ai/v1，模型 ID 与国内站一致（kimi-k3 / kimi-k2.6）。',
    docsUrl: 'https://platform.kimi.ai/console/api-keys',
  },
  {
    id: 'dashscope-intl',
    label: '阿里云百炼 Model Studio（国际站）',
    region: 'global',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.8-max',
    fastModel: 'qwen3.7-plus',
    keyRequired: true,
    notes: 'Model Studio 国际站的兼容模式地址；各地域 API Key 不可混用，官方后续推荐改用专属域名（ap-southeast-1 等）。',
    docsUrl: 'https://modelstudio.console.alibabacloud.com/',
  },
  /* ── 聚合网关 / 中转 ───────────────────────────────────────────────── */
  {
    id: 'opencode-go',
    label: 'OpenCode Go（订阅套餐）',
    region: 'gateway',
    baseUrl: 'https://opencode.ai/inference/go/v1',
    aliases: ['https://opencode.ai/inference/go/openai/v1'],
    model: 'deepseek-v4.1-flash',
    fastModel: 'glm-5.3-flash',
    keyRequired: true,
    notes: 'Go / Go Plus 订阅专用路径。**不要在按量付费入口（/inference/openai/v1、/inference/v1）上使用 Go 的 Key**：那里会按余额结算，余额为 0 时直接报 402「Insufficient account funds」，看起来像 Key 无效其实是走错了入口。走 Chat Completions 的模型：DeepSeek V4.1 Flash / V4 Pro、GLM-5.3 / 5.3-Flash / 5.2、Kimi K3 / K2.7 Code / K2.6、MiMo-V2.6 与 V2.5 系列、LongCat-2.0、Hy3、Hy4、Space Bunny 以及 LongCat / Step / CatJam 免费模型；Grok、GPT Luna、Claude Haiku、Gemini Argon、MiniMax、Qwen、Muse Spark 走的是 Responses / Messages / Google 协议，选了会 404。查错对照：401/403 = Key 类型或权限不对（须用 Console「Keys」里的 service account key）；402「Insufficient account funds」= 这次请求按预付余额结算且余额为零，也就是说 Go 订阅没有覆盖它（最常见：走错入口或 Key 与 Go 订阅不在同一个工作区；其次是订阅续费失败已失效、该模型额度用尽、余额为零）；额度用尽可在 Overview 的 credits 卡片打开 Extra usage 继续跑；404 = 选到了非 Chat Completions 家族的模型。可用 `curl https://opencode.ai/console/api/v2/config -H "Authorization: Bearer <你的Key>"` 自查：返回的 providers 里若只有 Console 而没有 Go，就说明这个 Key 所在工作区没有 Go 订阅。本应用会自动带 user-agent 与 x-opencode-session 头，符合官方对第三方客户端的要求。**另一条容易被忽略的官方限制**：Go 明确「面向 OpenCode 及其它同类编码 Agent 流量」并会监控滥用；本应用是投资分析流量，Console 显示订阅正常、额度未用尽却仍报 402 时，多半就是这类流量不被 Go 额度覆盖——此时请改用按量付费入口（充余额）或换其它供应商。',
    docsUrl: 'https://opencode.ai/console',
  },
  {
    id: 'opencode',
    label: 'OpenCode Console（按量付费）',
    region: 'gateway',
    baseUrl: 'https://opencode.ai/inference/v1',
    aliases: ['https://opencode.ai/inference/openai/v1'],
    model: 'deepseek-v4.1-flash',
    fastModel: 'glm-5.3-flash',
    keyRequired: true,
    notes: '按量付费（pay-as-you-go）入口，与 Go 订阅的 /inference/go/v1 不同。**如果你买的是 Go 订阅，请改选「OpenCode Go」预设**：在按量付费入口用 Go 的 Key，会按余额结算，余额为 0 时直接报 402「Insufficient account funds」（看似 Key 无效，实为入口用错）。免费模型仅限 OpenCode 客户端内使用（第三方调用返回 403「FreeTierError」）。只有 Chat Completions 家族可用（DeepSeek / GLM / Kimi / MiniMax / Qwen3.8 Max / Mistral Large 4 等）；GPT 系走 Responses、Claude 与 Gemini 系走 Messages，选了会 404。',
    docsUrl: 'https://opencode.ai/console',
  },
  {
    id: 'aihubmix',
    label: 'AiHubMix（聚合中转）',
    region: 'gateway',
    baseUrl: 'https://aihubmix.com/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '国内可直连的聚合网关；模型名沿用各厂商原名。',
    docsUrl: 'https://aihubmix.com/',
  },
  {
    id: 'ai302',
    label: '302.AI（聚合中转）',
    region: 'gateway',
    baseUrl: 'https://api.302.ai/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '聚合多家模型的付费中转；模型名沿用各厂商原名。',
    docsUrl: 'https://dash.302.ai/',
  },
  /* ── 本地推理（补充） ───────────────────────────────────────────────── */
  {
    id: 'llamacpp',
    label: '本地 llama.cpp server',
    region: 'local',
    baseUrl: 'http://localhost:9931/v1',
    model: 'local-model',
    fastModel: 'local-model',
    keyRequired: false,
    notes: '当前官方 llama-server 默认端口为 9931（旧版为 8080，按部署版本改端口）；单模型模式下模型名不参与路由，Key 填任意占位值。',
    docsUrl: 'https://github.com/ggml-org/llama.cpp',
  },
  {
    id: 'xinference',
    label: '本地 Xinference',
    region: 'local',
    baseUrl: 'http://localhost:9997/v1',
    model: 'qwen2.5-instruct',
    fastModel: 'qwen2.5-instruct',
    keyRequired: false,
    notes: '默认端口 9997；模型名需填启动时的 model_uid（未指定时等于模型名），Key 填任意占位值。',
    docsUrl: 'https://inference.readthedocs.io/',
  },
  {
    id: 'textgen',
    label: '本地 TextGen（原 text-generation-webui）',
    region: 'local',
    baseUrl: 'http://localhost:5000/v1',
    model: 'local-model',
    fastModel: 'local-model',
    keyRequired: false,
    notes: '项目已改名 TextGen，需以 --api 启动；API 默认端口 5000（Web UI 是 7860），默认不校验 Key，填任意占位值即可。',
    docsUrl: 'https://github.com/oobabooga/textgen',
  },
  {
    id: 'gpustack',
    label: '本地 GPUStack',
    region: 'local',
    baseUrl: 'http://localhost/v1',
    model: 'qwen3.5-0.8b',
    fastModel: 'qwen3.5-0.8b',
    keyRequired: true,
    notes: '默认监听 80 端口（故基址不带端口）；与其它本地服务不同，它必须带 API Key——在 UI 的 Access Control → API Keys 生成。',
    docsUrl: 'https://docs.gpustack.ai/latest/integrations/inference-apis/',
  },
  {
    id: 'kilo',
    label: 'Kilo 网关',
    region: 'gateway',
    baseUrl: 'https://api.kilo.ai/api/gateway',
    model: 'anthropic/claude-opus-5.5',
    fastModel: 'anthropic/claude-haiku-5.5',
    keyRequired: true,
    notes: '基址不含 /v1，本应用会直接拼 /chat/completions；模型名形如「组织/模型」。',
    docsUrl: 'https://kilo.ai/docs/gateway/api-reference',
  },
  {
    id: 'oneapi',
    label: '自建网关（One API / New API）',
    region: 'gateway',
    baseUrl: 'http://localhost:3000/v1',
    model: '',
    fastModel: '',
    keyRequired: true,
    notes: '自建中转的默认端口是 3000：把地址改成你的部署地址 + /v1，Key 用站内「令牌」页面生成的令牌；可选模型取决于已配置渠道。',
    docsUrl: 'https://github.com/songquanpeng/one-api',
  },
];

export const LLM_PROVIDER_PRESET_MAP: Record<string, LlmProviderPreset> = Object.fromEntries(
  LLM_PROVIDER_PRESETS.map((preset) => [preset.id, preset]),
);

/** 下拉框中「自定义」的哨兵值（不匹配任何预设时也显示它）。 */
export const LLM_PROVIDER_CUSTOM_ID = 'custom';

/** 归一化 Base URL：去空白、去末尾斜杠、小写，便于与预设比对。 */
export function normalizeLlmBaseUrl(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/** 按 Base URL 反查预设（含 `aliases` 等价地址）；未命中（自定义地址或为空）返回 undefined。 */
export function matchLlmProviderPreset(baseUrl: string): LlmProviderPreset | undefined {
  const target = normalizeLlmBaseUrl(baseUrl);
  if (!target) return undefined;
  return LLM_PROVIDER_PRESETS.find(
    (preset) =>
      normalizeLlmBaseUrl(preset.baseUrl) === target ||
      (preset.aliases ?? []).some((alias) => normalizeLlmBaseUrl(alias) === target),
  );
}

/** Tool authorisation defaults: nothing denied, writes execute immediately. */
export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  deny: [],
  requireWriteApproval: false,
};

/** No MCP servers configured out of the box. */
export const DEFAULT_MCP_SERVERS: McpServerConfig[] = [];

/* ──────────────────── agent context governance (P0) ──────────────────────── */

/** Tokens reserved for the model's own answer when compacting history. */
export const AGENT_OUTPUT_RESERVE_TOKENS = 4_096;
/** Always keep at least this many most-recent turns verbatim. */
export const AGENT_MIN_RECENT_TURNS = 4;
/** Older tool results are shrunk to at most this many characters. */
export const AGENT_OLD_TOOL_RESULT_CHARS = 600;

export const DEFAULT_DATA_SOURCES: DataSourceConfig = {
  stockCN: { provider: 'auto', enabled: true },
  stockHK: { provider: 'auto', enabled: true },
  stockUS: { provider: 'auto', enabled: true },
  fundCN: { provider: 'auto', enabled: true },
  fundHK: { provider: 'auto', enabled: true },
  fundUS: { provider: 'auto', enabled: true },
  webSearch: { provider: 'auto', enabled: true },
};

export const DEFAULT_BUDGET: BudgetConfig = { CN: 5000, HK: 5000, US: 1000 };

export const DEFAULT_SCHEDULE: ScheduleConfig = {
  mode: 'off',
  intervalMinutes: 1440,
  dailyTime: '08:30',
  runAssetAnalysis: true,
  runWatchlistAnalysis: true,
  runAdvice: true,
};

export const DEFAULT_PERSONA: Persona = 'balanced';
export const DEFAULT_REPORT_STYLE: ReportStyle = 'professional';
export const DEFAULT_WATCHLIST_CANDIDATE_LIMIT = 5;
/**
 * 自选标的淘汰阈值：连续多少次分析仍被 AI 标记退役后，才由流水线真正删除。
 * 0 = 只标记不删除（永不自动清理）。持仓 / 人工录入 / 有待处理建议的标的不受此值影响。
 */
export const DEFAULT_WATCHLIST_RETIRE_DELETE_RUNS = 3;
export const DEFAULT_ENFORCE_BUDGET = true;

/**
 * Data-source catalogue. `priority` orders the automatic fallback chain
 * (lower number wins). Only key-free providers are enabled out of the box.
 */
export const SOURCE_CATALOGUE: DataSourceCatalogueEntry[] = [
  {
    id: 'eastmoney',
    name: '东方财富（行情/财务）',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf'],
    requiresKey: false,
    priority: 10,
    notes: '零 Key，A股/港股/美股行情、K线、估值与主要财务指标。',
  },
  {
    id: 'tencent',
    name: '腾讯行情（备用）',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf'],
    requiresKey: false,
    priority: 20,
    notes: '零 Key，实时报价与 PE/PB/市值，作为东方财富失败时的兜底。',
  },
  {
    id: 'eastmoney-fund',
    name: '天天基金（净值/持仓）',
    markets: ['CN'],
    kinds: ['fund', 'etf'],
    requiresKey: false,
    priority: 10,
    notes: '零 Key，场外基金净值曲线、累计净值、持仓与阶段涨幅。',
  },
  {
    id: 'eastmoney-macro',
    name: '东方财富宏观数据中心',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf', 'fund'],
    requiresKey: false,
    priority: 10,
    notes: '零 Key，CPI/PPI/GDP/PMI/M2 等宏观指标与全球指数。',
  },
  {
    id: 'eastmoney-news',
    name: '东方财富资讯搜索',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf', 'fund'],
    requiresKey: false,
    priority: 10,
    notes: '零 Key，按关键词检索财经新闻与公告。',
  },
  {
    id: 'bing',
    name: 'Bing 网页搜索',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf', 'fund'],
    requiresKey: false,
    priority: 10,
    notes: '零 Key，用于挖掘研报、行业数据、国际局势等公开信息。',
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo 网页搜索',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf', 'fund'],
    requiresKey: false,
    priority: 30,
    notes: '零 Key 备用搜索源，部分网络环境下可能不可达。',
  },
  {
    id: 'tavily',
    name: 'Tavily Search API',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf', 'fund'],
    requiresKey: true,
    priority: 5,
    notes: '需 API Key，返回结构化摘要，适合作为首选搜索源。',
  },
  {
    id: 'serper',
    name: 'Serper.dev (Google)',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf', 'fund'],
    requiresKey: true,
    priority: 6,
    notes: '需 API Key，Google 搜索结果。',
  },
  {
    id: 'brave',
    name: 'Brave Search API',
    markets: ['CN', 'HK', 'US'],
    kinds: ['stock', 'etf', 'fund'],
    requiresKey: true,
    priority: 7,
    notes: '需 API Key。',
  },
  {
    id: 'yahoo',
    name: 'Yahoo Finance',
    markets: ['US', 'HK'],
    kinds: ['stock', 'etf'],
    requiresKey: false,
    priority: 25,
    notes: '零 Key，部分网络环境会被限流或拒绝（403）。',
  },
  {
    id: 'stooq',
    name: 'Stooq',
    markets: ['US'],
    kinds: ['stock', 'etf'],
    requiresKey: false,
    priority: 40,
    notes: '零 Key 历史行情兜底。',
  },
  {
    id: 'finnhub',
    name: 'Finnhub',
    markets: ['US'],
    kinds: ['stock', 'etf'],
    requiresKey: true,
    priority: 15,
    notes: '需 API Key，美股基本面与财报日历。',
  },
  {
    id: 'alphavantage',
    name: 'Alpha Vantage',
    markets: ['US', 'HK'],
    kinds: ['stock', 'etf'],
    requiresKey: true,
    priority: 16,
    notes: '需 API Key，美股/港股历史与基本面。',
  },
  {
    id: 'fmp',
    name: 'Financial Modeling Prep',
    markets: ['US'],
    kinds: ['stock', 'etf'],
    requiresKey: true,
    priority: 17,
    notes: '需 API Key，美股三大报表与估值指标。',
  },
];

export const SOURCE_CATALOGUE_MAP: Record<string, DataSourceCatalogueEntry> = Object.fromEntries(
  SOURCE_CATALOGUE.map((s) => [s.id, s]),
);

/** Keys of `DataSourceConfig` that map to a market/instrument slot. */
export type DataSourceSlot = keyof Omit<DataSourceConfig, 'webSearch'>;

export const DATA_SOURCE_SLOTS: { slot: DataSourceSlot; market: Market; kind: InstrumentType; label: string }[] = [
  { slot: 'stockCN', market: 'CN', kind: 'stock', label: 'A股 股票' },
  { slot: 'stockHK', market: 'HK', kind: 'stock', label: '港股 股票' },
  { slot: 'stockUS', market: 'US', kind: 'stock', label: '美股 股票' },
  { slot: 'fundCN', market: 'CN', kind: 'fund', label: 'A股 基金' },
  { slot: 'fundHK', market: 'HK', kind: 'fund', label: '港股 基金' },
  { slot: 'fundUS', market: 'US', kind: 'fund', label: '美股 基金' },
];

/** Eastmoney `secid` market prefix per market. */
export const EASTMONEY_MARKET_PREFIX: Record<Market, number> = {
  CN: 1,
  HK: 116,
  US: 105,
};

export const DEFAULT_HTTP_TIMEOUT_MS = 20_000;
export const DEFAULT_ASSET_CACHE_TTL_MS = 60_000;
export const DEFAULT_SERIES_CACHE_TTL_MS = 5 * 60_000;

/** Agent guard rails. */
/**
 * Turn cap. Only binds when a run genuinely needs the headroom (a converging run
 * exits early), so raising it costs nothing for cheap runs and rescues expensive
 * ones: production measured a `watchlist-analysis` stage using **12/12** turns and
 * writing nothing at all, after 393k prompt tokens.
 */
export const AGENT_MAX_TURNS = 20;
export const AGENT_MAX_TOOL_CALLS_PER_TURN = 6;
/**
 * Step cap (one step per LLM turn **and** per tool call). The same production run
 * used 12 + 61 = 73 of the old 80, so the step cap was about to bind as well.
 */
export const AGENT_MAX_STEPS = 160;

/** Extra turns granted by `POST /api/agent/runs/:id/resume` (P1-3). */
export const AGENT_RESUME_EXTRA_TURNS = 8;

/* ─────────────────────── agent execution tuning (P2) ─────────────────────── */

/**
 * How many **read/external** tool calls from one assistant message may run at the
 * same time. Write tools are always executed alone and in order (barriers), so
 * ledger mutations keep a deterministic sequence.
 */
export const AGENT_TOOL_CONCURRENCY = 4;
/** Retries for transient LLM failures (429 / 5xx / network) with exponential backoff. */
export const LLM_MAX_RETRIES = 3;
/** Base delay for that backoff (doubled per attempt, plus jitter). */
export const LLM_RETRY_BASE_MS = 800;
/**
 * Retries for an **empty completion** (no content and no tool calls).
 *
 * A blank turn is a gateway hiccup, not an answer — production saw a 129k-token
 * advice stage die on one blank turn and lose the whole batch (and the same
 * happened again on 2026-10-15: run `381bd718` died on turn 7 after 129,183
 * prompt tokens). Retrying is far cheaper than throwing the stage away, so the
 * retry budget is deliberately generous compared with the network retries.
 */
export const LLM_MAX_EMPTY_RETRIES = 4;
/** Base delay before retrying an empty completion (linear in the retry index). */
export const LLM_EMPTY_RETRY_BASE_MS = 400;
