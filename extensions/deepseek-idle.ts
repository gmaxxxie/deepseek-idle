/**
 * DeepSeek Idle-Time Switcher
 *
 * 在 DeepSeek 官方 API 空闲时段(半价)自动切换到官方模型；
 * 高峰时段保持用户手动选择的模型(如 new-api/nextapi 网关)。
 *
 * 空闲时段(北京时间): 周一至周五 09:00-12:00、14:00-18:00 之外的所有时间(含周末全天)
 *
 * 用法:
 *   /ds            - 查看当前状态
 *   /ds on         - 开启自动切换
 *   /ds off        - 关闭自动切换
 *   /ds status     - 查看状态
 *   /ds now        - 立即切换到官方模型(空闲时段)
 *
 * 配置: ~/.pi/agent/extensions/deepseek-idle.json
 * API key: 环境变量 DEEPSEEK_API_KEY (或在配置里写死)
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
  official?: {
    baseUrl?: string;
    apiKey?: string;
    api?: string;
    providerName?: string;
    model?: string;
  };
  schedule?: {
    timezone?: string;
    peakWindows?: TimeWindow[];
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
  // 包内示例: 本文件同目录的 deepseek-idle.json
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
    baseUrl: "https://api.deepseek.com",
    apiKey: "$DEEPSEEK_API_KEY",
    api: "openai-completions",
    providerName: "deepseek-official",
    model: "deepseek-flash",
  },
  schedule: {
    timezone: "Asia/Shanghai",
    peakWindows: [
      { start: "09:00", end: "12:00" },
      { start: "14:00", end: "18:00" },
    ],
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
      const cfg = {
        enabled: parsed.enabled ?? DEFAULT_CONFIG.enabled,
        official: { ...DEFAULT_CONFIG.official, ...(parsed.official ?? {}) },
        schedule: { ...DEFAULT_CONFIG.schedule, ...(parsed.schedule ?? {}) },
        peak: { ...DEFAULT_CONFIG.peak, ...(parsed.peak ?? {}) },
      };
      // 环境变量覆盖 API key (优先级最高, 避免共享包带 key)
      if (process.env.DEEPSEEK_API_KEY) {
        cfg.official.apiKey = process.env.DEEPSEEK_API_KEY;
      }
      return cfg;
    }
  } catch (err) {
    console.error("[deepseek-idle] 读取配置失败:", err);
  }
  // 配置不存在 → 用默认值(API key 用环境变量)
  const def = structuredClone(DEFAULT_CONFIG);
  if (process.env.DEEPSEEK_API_KEY) {
    def.official.apiKey = process.env.DEEPSEEK_API_KEY;
  }
  return def;
}

/** 判断给定时间是否处于高峰时段(北京时间)。返回 true=高峰 */
function isPeakTime(cfg: Config, now: Date): boolean {
  const tz = cfg.schedule?.timezone ?? DEFAULT_CONFIG.schedule.timezone;
  const windows = cfg.schedule?.peakWindows ?? DEFAULT_CONFIG.schedule.peakWindows;

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

  // 检查高峰窗口 (start <= t < end)
  for (const w of windows ?? []) {
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    const startM = sh * 60 + sm;
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
  const officialProvider = cfg.official!.providerName!;
  const officialModelId = cfg.official!.model!;
  const officialModelName = `${officialProvider}/${officialModelId}`;

  // 扩展运行时开关(会话内; 持久化到 session entry)
  let extEnabled = cfg.enabled !== false;
  let lastSwitch = "";
  let lastTarget: string | null = null;

  // 记录最近一次自动切换到的模型, 避免重复切换
  let lastAutoTarget: string | null = null;
  // 记录用户手动选择的模型(高峰时段切回目标), 通过 model_select 跟踪
  let userModelRef: string | null = null;

  // =============================================================================
  // 注册 DeepSeek 官方 provider
  // =============================================================================

  pi.registerProvider(officialProvider, {
    name: "DeepSeek Official",
    baseUrl: cfg.official!.baseUrl!,
    apiKey: cfg.official!.apiKey!,
    api: (cfg.official!.api as any) ?? "openai-completions",
    models: [
      {
        id: officialModelId,
        name: "DeepSeek Flash (官方, 空闲半价)",
        reasoning: true,
        input: ["text"],
        // 空闲时段价格 (CNY/1M tokens): 缓存命中 0.02, 输入 1, 输出 4
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
    const state: State = {
      extEnabled,
      lastSwitch,
      lastTarget,
    };
    if (ctx) {
      pi.appendEntry<State>(STATE_ENTRY_TYPE, state);
    }
  }

  // =============================================================================
  // 自动切换核心
  // =============================================================================

  /**
   * 空闲时段切换到官方模型; 高峰时段保持用户手动选择的模型。
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

    // 查找官方模型对象
    const officialModel = ctx.modelRegistry.find(officialProvider, officialModelId);
    if (!officialModel) {
      return { switched: false, message: `找不到官方模型 ${officialModelName}` };
    }

    if (peak) {
      // 高峰时段: 切换到 peak 配置的模型 (或用户手动选的模型)
      const peakProvider = cfg.peak?.provider ?? "";
      const peakModelId = cfg.peak?.model ?? "";
      // 若 peak 未配置, 回退到用户手动选的模型
      const targetProvider = peakProvider || (userModelRef ? userModelRef.split("/")[0] : "");
      const targetModelId = peakModelId || (userModelRef ? userModelRef.split("/")[1] : "");
      const peakRef = targetProvider && targetModelId ? `${targetProvider}/${targetModelId}` : "";

      // 当前已是目标 → 无需切换
      if (!peakRef || currentRef === peakRef) {
        return {
          switched: false,
          message: peakRef
            ? `高峰时段(${timeStr}), 已在 ${peakRef}`
            : `高峰时段(${timeStr}), 保持当前模型 ${currentRef || "未知"}`,
        };
      }

      const peakModel = ctx.modelRegistry.find(targetProvider, targetModelId);
      if (!peakModel) {
        return {
          switched: false,
          message: `高峰时段: 找不到模型 ${peakRef} (可用 /df peak <provider/model> 设置)`,
        };
      }

      const ok = await pi.setModel(peakModel);
      if (!ok) {
        return {
          switched: false,
          message: `高峰时段: 切换失败 ${peakRef} (未配置 API key?)`,
        };
      }

      lastSwitch = timeStr;
      lastTarget = peakRef;
      lastAutoTarget = peakRef;
      persistState(ctx);

      return {
        switched: true,
        message: `高峰时段(${timeStr}), 已切换到 ${peakRef}`,
      };
    }

    // 空闲时段: 切换到官方模型(如果当前不是)
    if (currentRef === officialModelName) {
      return { switched: false, message: `已在官方模型(${timeStr})` };
    }

    const ok = await pi.setModel(officialModel);
    if (!ok) {
      return {
        switched: false,
        message: `切换失败: ${officialModelName} 未配置 API key (检查 DEEPSEEK_API_KEY)`,
      };
    }

    lastSwitch = timeStr;
    lastTarget = officialModelName;
    lastAutoTarget = officialModelName;
    persistState(ctx);

    return {
      switched: true,
      message: `空闲时段(${timeStr}), 已切换到官方 ${officialModelName}`,
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
  // 事件: 会话启动恢复
  // =============================================================================

  pi.on("session_start", (_event, ctx) => {
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
          : "未设置";
        ctx.ui.notify(`高峰时段目标: ${peakRef}`, "info");
        return;
      }
      // 解析 provider/model 或 provider/model:model
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
