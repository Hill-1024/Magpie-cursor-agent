# Cursor · Magpie Bridge (Clean-Room Shadow Implementation)

从零实现的无二进制、无第三方依赖 Cursor ↔ Magpie 协议桥接插件，让 Cursor 直接使用 Magpie 中配置的全部模型与路由组。

## 安全与隔离设计

- **零预编译二进制**：完全移除不透明可执行文件，全链路以可读 ESM JavaScript 运行于 Node.js 或 Magpie 内置 Bun。
- **零第三方运行时依赖**：移除 `node_modules` 依赖包，内置独立实现的 JSONC 编辑器、ASN.1 DER X.509 证书签发器与 Protobuf 编解码器。
- **源码完整性校验**：`integrity.json` 对全部运行文件进行 SHA-256 校验，安装与启动阶段显式核验。
- **无落盘会话隐私存储**：不建立本地 SQLite 数据库持久化用户提示词、响应或密钥；会话与 Blob 仅驻留内存。
- **严格回环与最小拦截**：仅对 `*.cursor.sh` 执行本地 TLS 协议桥接，非 Cursor 域名通过原生 TCP 透传；遥测与模型目录请求在本地隔离处理，网关地址仅允许本机回环 HTTP。

## 常用命令

```bash
# 校验完整性并初始化证书与后台服务
bash setup.command

# 查看后台运行状态
bash setup.command status

# 停用服务并精确还原 Cursor 代理配置
bash setup.command uninstall

# 运行全部自动化测试
npm test
```

## Magpie 插件集成与分角色模型配置

本仓库遵循 `yetone/magpie` 的双模块插件规范：

- `agent.js` 仅包含纯 `moejs` 沙箱元数据（`id: "cursor-bridge"`、`effort: true`、`connect()`），使插件直接出现在 Magpie **Agents** 列表中并支持一键开关、主模型与推理强度选择。
- `plugin.js`（`package.json` `main`）由 Magpie Bun Plugin Host 自动加载，负责拉起/升级后台桥接，并在回环地址（默认 `http://127.0.0.1:19381`）提供诊断服务；该服务不再出现在 Magpie 侧栏。
- Magpie UI 扩展（`ui/panel.html`）：直接在 Agents 页面下方配置主模型之外的全部角色模型，不再单开插件页。

支持按职责单独指定模型（可选附加 `[reasoning=low|medium|high|xhigh]`，留空则沿用主模型）：

- `autoRouterModel`：Cursor 原生 `Auto` 模式的路由控制模型，负责从 Magpie 全量模型目录中选择最合适的执行模型；留空默认使用 `cursor/auto`（目录只有 `cursor/auto-smart` 时用它，两者都没有才回退主模型）。仅对原生 `Auto` 生效，不会劫持或干扰用户手动选择的 `cursor/auto`/`cursor/auto-smart`，且每次会话轮次严格单跳防回环。
- `subagentModel` / `subagentTypeModels`：子代理默认模型及按类型（如 `explore`、`shell`、`generalPurpose`、`browser-use`）细分映射。
- `bugbotModel`：Bugbot 自动审阅、`StreamBugBot`、`StreamBugBotLinter` 与 `StreamDiffReview`。
- `securitybotModel`：SecurityBot 安全审查与漏洞扫描子代理。
- `titleModel`：会话与分支标题命名（`NameAgent`、`GetChatTitle`、`WriteGitBranchName`）。
- `summarizeModel`：长对话摘要与压缩（`SummarizeAction`、`CreateTranscriptOverview`、`GetConversationSummary`）。
- `memoryModel`：记忆提取与整理（`PotentiallyGenerateMemory` 及记忆子代理）。
- `commitModel`：Git 提交信息生成（`WriteGitCommitMessage`）。

在 Magpie Agents 页面保存写入 `~/.config/magpie/plugins.json` 的选项；高级用户仍可在本地诊断页写入 `~/.config/magpie-cursor-bridge/roles.json`。后台每 1 秒自动对比两者修改时间并取最新一份热生效，无需重启 Cursor。
