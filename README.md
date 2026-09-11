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

## 安装

### 1. 安装包

```bash
pi install git:github.com/<你的用户名>/deepseek-idle
```

或本地目录：

```bash
pi install /path/to/deepseek-idle-pkg
```

### 2. 在 pi 中配置 DeepSeek 官方 provider

编辑 `~/.pi/agent/models.json`（或用 `pi config`），加入：

```json
{
  "providers": {
    "deepseek-official": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DeepSeek Flash (官方)",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 1000000,
          "maxTokens": 384000,
          "cost": { "input": 1, "output": 4, "cacheRead": 0.02, "cacheWrite": 0 },
          "compat": {
            "supportsStore": false,
            "supportsDeveloperRole": false,
            "maxTokensField": "max_tokens",
            "requiresReasoningContentOnAssistantMessages": true,
            "thinkingFormat": "deepseek"
          }
        }
      ]
    }
  }
}
```

设置 API key（推荐环境变量，包内不含任何 key）：

```bash
export DEEPSEEK_API_KEY="sk-你的key"
```

### 3. 配置高峰回切目标（可选）

默认高峰回切目标为 `new-api/deepseek-v4-flash`，可用命令修改：

```bash
/df peak new-api/deepseek-v4-flash   # 设置高峰回切目标
/df peak                              # 查看当前高峰目标
```

## 使用

| 命令 | 功能 |
|------|------|
| `/df` 或 `/df status` | 查看状态 |
| `/df on` | 开启自动切换 |
| `/df off` | 关闭自动切换 |
| `/df now` | 立即切换 |
| `/df peak <provider>/<model>` | 设置高峰回切目标 |
| `/ds ...` | `/df` 的别名 |

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
    ]
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
