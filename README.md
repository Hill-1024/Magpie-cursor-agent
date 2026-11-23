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
