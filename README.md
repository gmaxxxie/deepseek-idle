# pi-deepseek-idle

DeepSeek 空闲时段（半价）自动切换扩展 for [pi](https://pi.dev)。

在 DeepSeek 官方 API 的**空闲时段（off-peak，半价）**自动切换到官方模型；在**高峰时段**自动切回你指定的 provider（如 nextapi/new-api 网关）。

## 功能

- 🌙 **空闲时段**（半价）：自动切换到 DeepSeek 官方模型的 `deepseek-flash`
- ⛰️ **高峰时段**：自动切回配置的 provider（默认 `new-api/deepseek-v4-flash`，可改）
- 每轮对话开始前自动检查并切换，幂等不重复
- 状态栏常驻显示：`⛰️Peak new-api` / `🌙Idle deepseek-official`
- 可随时开关、手动切换、设置高峰目标

## 设计

> 本扩展**不注册任何 provider**，只负责**定时切换模型**。
> DeepSeek 官方和你的网关都是 pi 自己的 provider（配置在 `models.json` / `settings.json`），扩展从 pi 模型注册表读取模型并调用 `pi.setModel()` 切换。这样 API key、模型配置统一由 pi 管理。

## 空闲时段规则（DeepSeek 官方）

- **高峰时段**（北京时间）：周一至周五 `09:00-12:00`、`14:00-18:00`
- **空闲时段**：其余所有时间 + **周末全天** → 官方 API **半价**
- **提前切换**：高峰开始前 5 分钟（`prePeakMinutes`）就提前切回网关，避免会话中途进入高峰还在用官方

## 安装

### 1. 安装包

```bash
pi install git:github.com/gmaxxxie/deepseek-idle
```

### 2. 设置 API key

```bash
export DEEPSEEK_API_KEY="sk-你的key"
```

### 3. 完成 ✓

扩展启动时会自动检查 pi 中是否已配置 `deepseek-official` provider：

- **已配置**（如在 `models.json` / `settings.json`）→ 直接使用，只负责切换模型
- **未配置** → 自动注册（从 `DEEPSEEK_API_KEY` 环境变量读取 key）

无需手动改 `models.json`！

## 使用

| 命令 | 功能 |
|------|------|
| `/df` 或 `/df status` | 查看状态 |
| `/df on` | 开启自动切换 |
| `/df off` | 关闭自动切换 |
| `/df now` | 立即切换 |
| `/df peak <provider>/<model>` | 设置高峰回切目标 |
| `/ds ...` | `/df` 的别名 |

默认高峰回切目标为 `new-api/deepseek-v4-flash`，可随时修改：

```bash
/df peak new-api/deepseek-v4-flash   # 设置高峰回切目标
/df peak                              # 查看当前高峰目标
```

## 配置项

配置文件 `deepseek-idle.json`（查找顺序：`$DEEPSEEK_IDLE_CONFIG` → `~/.pi/agent/extensions/deepseek-idle.json` → 包内示例）：

```json
{
  "enabled": true,
  "official": {
    "provider": "deepseek-official",
    "model": "deepseek-flash"
  },
  "schedule": {
    "timezone": "Asia/Shanghai",
    "peakWindows": [
      { "start": "09:00", "end": "12:00" },
      { "start": "14:00", "end": "18:00" }
    ],
    "prePeakMinutes": 5
  },
  "peak": {
    "provider": "new-api",
    "model": "deepseek-v4-flash"
  }
}
```

## 开发

```bash
# 本地测试
pi -e ./extensions/deepseek-idle.ts
```

无第三方运行时依赖（仅用 Node 内置模块与 pi 类型），无需 `npm install`。

## License

MIT
