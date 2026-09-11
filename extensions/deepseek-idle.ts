/**
 * DeepSeek Idle-Time Switcher
 *
 * 在 DeepSeek 官方 API 空闲时段(半价)自动切换到官方模型；
 * 高峰时段自动切回指定 provider (如 new-api/nextapi 网关)。
 *
 * 空闲时段(北京时间): 周一至周五 09:00-12:00、14:00-18:00 之外的所有时间(含周末全天)
 *
 * 用法:
 *   /ds            - 查看当前状态
 *   /ds on         - 开启自动切换
 *   /ds off        - 关闭自动切换
 *   /ds status     - 查看状态
 *   /ds now        - 立即切换到当前时段应用的模型
 *   /ds peak <provider/model> - 设置高峰时段回切目标
 *
 * 依赖: DeepSeek 官方 provider 已在 pi 中配置 (models.json / settings.json)
 *   - provider 名: deepseek-official (默认, 可通过配置改)
 *   - 模型: deepseek-flash / deepseek-v4-pro
 *   - API key: 推荐环境变量 DEEPSEEK_API_KEY
 *
 * 配置: ~/.pi/agent/extensions/deepseek-idle.json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// =============================================================================
// 类型定义
// =============================================================================

interface TimeWindow {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
}

interface Config {
  enabled?: boolean;
  /** 官方 provider 配置 (已在 pi 中注册, 这里只记录引用) */
  official?: {
    provider?: string;
    model?: string;
  };
  schedule?: {
    timezone?: string;
    peakWindows?: TimeWindow[];
    /** 高峰提前量(分钟): 距高峰开始前 N 分钟就按高峰处理, 避免会话中还在用官方 */
    prePeakMinutes?: number;
  };
  /** 高峰时段目标(回切 provider) */
  peak?: {
    provider?: string;
    model?: string;
  };
}

interface State {
  extEnabled: boolean;      // 扩展开关(持久化)
  lastSwitch: string;       // 最近一次自动切换的时间
  lastTarget: string | null; // 最近自动切换到的模型 "provider/id"
}

// =============================================================================
// 常量 & 默认值
// =============================================================================

const HOME = process.env.HOME || "";
// 配置查找路径(依次):
// 1. $DEEPSEEK_IDLE_CONFIG 环境变量指定
// 2. 用户扩展目录 ~/.pi/agent/extensions/deepseek-idle.json (本机配置)
// 3. 包内示例配置 (与扩展同目录的 .json)
function findConfigPath(): string {
  if (process.env.DEEPSEEK_IDLE_CONFIG) return process.env.DEEPSEEK_IDLE_CONFIG;
  const userConfig = resolve(HOME, ".pi/agent/extensions/deepseek-idle.json");
  if (existsSync(userConfig)) return userConfig;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const localConfig = resolve(here, "deepseek-idle.json");
    if (existsSync(localConfig)) return localConfig;
  } catch {
    // import.meta.url 不可用时忽略
  }
  return userConfig;
}
const CONFIG_PATH = findConfigPath();
const STATE_ENTRY_TYPE = "deepseek-idle-state";

const DEFAULT_CONFIG: Required<Config> = {
  enabled: true,
  official: {
    provider: "deepseek-official",
    model: "deepseek-flash",
  },
  schedule: {
    timezone: "Asia/Shanghai",
    peakWindows: [
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ],
    prePeakMinutes: 5,
  },
  peak: {
    provider: "new-api",
    model: "deepseek-v4-flash",
  },
};

// =============================================================================
// 工具函数
// =============================================================================

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      const parsed = JSON.parse(raw) as Config;
      // 深度合并到默认值
      return {
        enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
        official: { ...DEFAULT_CONFIG.official, ...(parsed.official ?? {}) },
        schedule: { ...DEFAULT_CONFIG.schedule, ...(parsed.schedule ?? {}) },
        peak: { ...DEFAULT_CONFIG.peak, ...(parsed.peak ?? {}) },
      };
    }
  } catch (err) {
    console.error("[deepseek-idle] 读取配置失败:", err);
  }
  return structuredClone(DEFAULT_CONFIG);
}

/** 判断给定时间(含高峰提前量)是否处于高峰时段(北京时间)。返回 true=高峰 */
function isPeakTime(cfg: Config, now: Date): boolean {
  const tz = cfg.schedule?.timezone ?? DEFAULT_CONFIG.schedule.timezone;
  const windows = cfg.schedule?.peakWindows ?? DEFAULT_CONFIG.schedule.peakWindows;
  const leadMinutes = cfg.schedule?.prePeakMinutes ?? 0;

  // 用 Intl 获取北京时间的小时:分钟
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(now);

  const weekdayPart = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const isWeekend = weekdayPart === "Sat" || weekdayPart === "Sun";
  const minutes = hour * 60 + minute;

  // 周末全天空闲
  if (isWeekend) return false;

  // 检查高峰窗口。提前量只作用于开始: now >= (start - lead) && now < end
  for (const w of windows ?? []) {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    const startM = sh * 60 + sm - leadMinutes; // 开始前 lead 分钟即视为高峰
    const endM = eh * 60 + em;
    if (minutes >= startM && minutes < endM) return true;
  }
  return false;
}

/** 格式化当前时间(北京时间) */
function formatNow(cfg: Config, now: Date): string {
  const tz = cfg.schedule?.timezone ?? DEFAULT_CONFIG.schedule.timezone;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
}

// =============================================================================
// 扩展入口
// =============================================================================

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const officialProvider = cfg.official!.provider!;
  const officialModelId = cfg.official!.model!;
  const officialModelName = `${officialProvider}/${officialModelId}`;

  // 扩展运行时开关(会话内; 持久化到 session entry)
  let extEnabled = cfg.enabled !== false;
  let lastSwitch = "";
  let lastTarget: string | null = null;
  let lastAutoTarget: string | null = null;
  // 记录用户手动选择的模型(非官方模型的都算用户手动选)
  let userModelRef: string | null = null;

  // =============================================================================
  // 状态栏更新
  // =============================================================================

  function updateStatus(ctx?: ExtensionContext) {
    const now = new Date();
    const peak = isPeakTime(cfg, now);
    const model = ctx?.model ?? undefined;

    if (!extEnabled) {
      ctx?.ui.setStatus("deepseek-idle", undefined);
      return;
    }

    const label = peak ? "⛰️Peak" : "🌙Idle";
    ctx?.ui.setStatus("deepseek-idle", `${label} ${model?.provider ?? "?"}`);
  }

  // =============================================================================
  // 从 session entry 恢复开关状态
  // =============================================================================

  function restoreState(ctx: ExtensionContext) {
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
          const data = entry.data as State;
          extEnabled = data.extEnabled ?? (cfg.enabled !== false);
          lastSwitch = data.lastSwitch ?? "";
          lastTarget = data.lastTarget ?? null;
          break;
        }
      }
    } catch {
      // ignore
    }
  }

  function persistState(ctx?: ExtensionContext) {
    const state: State = { extEnabled, lastSwitch, lastTarget };
    if (ctx) {
      pi.appendEntry<State>(STATE_ENTRY_TYPE, state);
    }
  }

  // =============================================================================
  // 自动切换核心
  // =============================================================================

  /**
   * 空闲时段切换到官方模型; 高峰时段切回 peak 配置的模型 (或用户手动选)。
   * 返回切换结果描述。
   */
  async function autoSwitch(ctx: ExtensionContext): Promise<{ switched: boolean; message: string }> {
    if (!extEnabled) {
      return { switched: false, message: "扩展已关闭" };
    }

    const now = new Date();
    const peak = isPeakTime(cfg, now);
    const timeStr = formatNow(cfg, now);

    // 当前实际使用的模型
    const current = ctx?.model ?? undefined;
    const currentRef = current ? `${current.provider}/${current.id}` : "";

    // 记录用户手动选的模型(非官方模型的都算用户手动选)
    if (current && current.provider !== officialProvider) {
      userModelRef = currentRef;
    }

    // 目标模型
    let targetProvider: string;
    let targetModelId: string;
    if (peak) {
      // 高峰: peak 配置 → 回退用户手动选
      targetProvider = cfg.peak?.provider || (userModelRef ? userModelRef.split("/")[0] : "");
      targetModelId = cfg.peak?.model || (userModelRef ? userModelRef.split("/")[1] : "");
    } else {
      // 空闲: 官方模型
      targetProvider = officialProvider;
      targetModelId = officialModelId;
    }

    const targetRef = targetProvider && targetModelId ? `${targetProvider}/${targetModelId}` : "";

    // 当前已是目标 → 无需切换
    if (!targetRef || currentRef === targetRef) {
      return {
        switched: false,
        message: targetRef
          ? `${peak ? "高峰" : "空闲"}时段(${timeStr}), 已在 ${targetRef}`
          : `${peak ? "高峰" : "空闲"}时段(${timeStr}), 无目标模型`,
      };
    }

    // 从 pi 模型注册表查找目标模型 (不在 pi 里配置的无法切换)
    const targetModel = ctx.modelRegistry.find(targetProvider, targetModelId);
    if (!targetModel) {
      return {
        switched: false,
        message: `找不到模型 ${targetRef} — 请确认已在 pi 中配置该 provider (models.json/settings.json)`,
      };
    }

    const ok = await pi.setModel(targetModel);
    if (!ok) {
      return {
        switched: false,
        message: `切换失败: ${targetRef} 未配置 API key`,
      };
    }

    lastSwitch = timeStr;
    lastTarget = targetRef;
    lastAutoTarget = targetRef;
    persistState(ctx);

    return {
      switched: true,
      message: `${peak ? "高峰" : "空闲"}时段(${timeStr}), 已切换到 ${targetRef}`,
    };
  }

  // =============================================================================
  // 事件: 每轮 agent 开始前自动切换
  // =============================================================================

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!extEnabled) return;
    const result = await autoSwitch(ctx);
    if (result.switched) {
      ctx.ui.notify(result.message, "info");
    }
    updateStatus(ctx);
  });

  // =============================================================================
  // 事件: 模型变化时更新状态栏 (含用户手动切换)
  // =============================================================================

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  // =============================================================================
  // 兜底: 若 pi 中未配置官方 provider, 自动注册
  // (本机已配置则不重复注册; 其他设备只需设 DEEPSEEK_API_KEY)
  // =============================================================================

  function ensureOfficialProvider(ctx: ExtensionContext) {
    try {
      const existing = ctx.modelRegistry.getProvider(officialProvider);
      if (existing) {
        return; // 已配置, 尊重现有配置
      }
    } catch {
      // 忽略检查失败, 继续尝试注册
    }

    // 需要 API key 才能注册
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.warn(
        `[deepseek-idle] 未找到官方 provider '${officialProvider}' 且未设置 DEEPSEEK_API_KEY, 跳过自动注册`,
      );
      return;
    }

    // 兜底注册官方 provider (仅当 pi 中不存在时)
    pi.registerProvider(officialProvider, {
      name: "DeepSeek Official (自动)",
      baseUrl: "https://api.deepseek.com",
      apiKey,
      api: "openai-completions",
      models: [
        {
          id: officialModelId,
          name: `DeepSeek ${officialModelId} (官方)`,
          reasoning: true,
          input: ["text"],
          cost: { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: "max_tokens",
            requiresReasoningContentOnAssistantMessages: true,
            thinkingFormat: "deepseek",
          },
        },
      ],
    });
    console.log(`[deepseek-idle] 已自动注册官方 provider '${officialProvider}'`);
  }

  // =============================================================================
  // 事件: 会话启动恢复
  // =============================================================================

  pi.on("session_start", (_event, ctx) => {
    ensureOfficialProvider(ctx);
    restoreState(ctx);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    // 清理状态栏
  });

  // =============================================================================
  // /ds 与 /df 命令 (共享 handler)
  // =============================================================================

  const dsHandler = async (args: string | undefined, ctx: ExtensionContext) => {
    const arg = (args ?? "").trim().toLowerCase();

    if (arg === "on" || arg === "enable") {
      extEnabled = true;
      persistState(ctx);
      ctx.ui.notify("DeepSeek 空闲时段切换已开启", "info");
      const r = await autoSwitch(ctx);
      if (r.switched) ctx.ui.notify(r.message, "info");
      updateStatus(ctx);
      return;
    }

    if (arg === "off" || arg === "disable") {
      extEnabled = false;
      persistState(ctx);
      ctx.ui.setStatus("deepseek-idle", undefined);
      ctx.ui.notify("DeepSeek 空闲时段切换已关闭", "info");
      return;
    }

    if (arg === "now") {
      const r = await autoSwitch(ctx);
      ctx.ui.notify(r.message, r.switched ? "info" : "warning");
      updateStatus(ctx);
      return;
    }

    if (arg === "peak" || arg.startsWith("peak ")) {
      const target = args!.trim().slice(5).trim();
      if (!target) {
        const peakRef = cfg.peak?.provider && cfg.peak?.model
          ? `${cfg.peak.provider}/${cfg.peak.model}`
          : "未设置(回退用户手动选)";
        ctx.ui.notify(`高峰时段目标: ${peakRef}`, "info");
        return;
      }
      // 解析 provider/model
      const parts = target.split("/");
      const provider = parts[0]?.trim();
      const model = parts[1]?.trim();
      if (!provider || !model) {
        ctx.ui.notify(`格式: /df peak <provider>/<model> (如 new-api/deepseek-v4-flash)`, "warning");
        return;
      }
      cfg.peak = { provider, model };
      ctx.ui.notify(`高峰时段目标已设为 ${provider}/${model}`, "info");
      // 立即尝试切换(若当前高峰)
      const r = await autoSwitch(ctx);
      if (r.switched) ctx.ui.notify(r.message, "info");
      updateStatus(ctx);
      return;
    }

    // 默认: status
    const now = new Date();
    const peak = isPeakTime(cfg, now);
    const timeStr = formatNow(cfg, now);
    const current = ctx.model;
    const currentRef = current ? `${current.provider}/${current.id}` : "无";
    const peakRef = cfg.peak?.provider && cfg.peak?.model
      ? `${cfg.peak.provider}/${cfg.peak.model}`
      : (userModelRef ?? "保持手动");

    ctx.ui.notify(
      [
        `状态: ${extEnabled ? "开" : "关"}`,
        `当前时段: ${timeStr} — ${peak ? "高峰" : "空闲"}`,
        `当前模型: ${currentRef}`,
        `空闲时段目标: ${officialModelName}`,
        `高峰时段目标: ${peakRef}`,
      ].join(" | "),
      extEnabled ? "info" : "warning",
    );
    updateStatus(ctx);
  };

  pi.registerCommand("ds", {
    description:
      "DeepSeek 时段切换: /ds [on|off|status|now|peak <provider/model>] — 空闲用官方API, 高峰切回指定provider",
    handler: dsHandler,
  });

  // 别名: /df = /ds
  pi.registerCommand("df", {
    description: "DeepSeek 时段切换别名 (同 /ds)",
    handler: dsHandler,
  });
}
