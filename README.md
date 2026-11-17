# Daily Usage for Claude++

独立的 Claude++ tweak，按北京时间查看今天、最近 7 天、最近 30 天的 Token 和 Standard API 等值美元。
按机器、日期和模型拆分，包含子代理。版本 0.1.4；需要 Windows、Claude++ 0.3.11 或更新版本。
无需安装或启用 Session Stats。

## 安装和使用

在 **Claude++ Settings → Tweak Store** 搜索 **Daily Usage** 安装，随后打开设置中的 **Daily Usage** 页面。
运行时无 npm 依赖。也可以从 [v0.1.4 Release](https://github.com/kpkhxlgy0/claude-daily-usage/releases/tag/v0.1.4)
下载 `claude-daily-usage-0.1.4.zip`，解压到长期保留的目录，在 PowerShell7 运行：

```powershell
pwsh -File .\Inject-ClaudePlusPlus.ps1 -CheckOnly
pwsh -File .\Inject-ClaudePlusPlus.ps1
```

本机默认选中。要查看远程机器，先在当前窗口打开该机器上的 Remote Control 会话，再打开 Daily Usage。
机器下拉框中本机只显示“本机”，只有一个远程入口时只显示“远程”；多个远程入口时显示名称以便区分。
两端更新至 0.1.3 或更高版本后可识别运行电脑的主机名；离线保留上次名称，未识别时显示会话 ID。
每个入口读取对应运行机器的全机汇总，同机多个会话可能显示多个入口。新旧版本混用时统计查询仍可使用。
**查看端和运行端都必须安装并启用此 tweak，运行端 Claude++ 应用需要保持运行。** 无需在运行端打开统计页。

查询时机与 Codex++ Daily Usage 一致：

- 打开页面、切换机器或点击刷新时，各查询一次；切换日期范围只筛选已返回的数据。
- 机器名称仅在打开页面时按需读取并缓存，离开页面立即取消；名称读取不会触发用量扫描。
- 页面保持打开时也不会定时刷新。首次查询会读取保留的历史，可能需要一段时间。
- 离开、隐藏或关闭页面会取消当前查询；多个窗口的需求互不取消，最后一个需求释放后终止统计 worker。
- 启用时不扫描用量日志，不创建统计 worker；没有后台轮询或定时统计。
- 运行端空闲时保留文件/原生事件监听，用于识别连接和接收查询通知。断线遗留任务最长约 5 分钟结束。

不支持原生通知或连接不可用时显示错误/最后成功缓存，不回退到后台轮询。
普通聊天消息不会触发统计，也不会为统计发送提示词、调用模型或执行 MCP 工具。

禁用可在 Tweaks 中完成，或运行 `pwsh -File .\Uninject-ClaudePlusPlus.ps1`。
脚本只操作 `%APPDATA%/claude-plusplus` 下此 tweak 的启用状态和指向当前源码的开发链接，
保留源码、统计缓存、Store 安装副本及其他 tweaks；不会自动退出或重启 Claude。

## 数字表示什么

- 来源为运行机器 `CLAUDE_CONFIG_DIR/projects/**/*.jsonl`，未设置时使用 `~/.claude/projects`，包含子代理目录。
  只统计该用户配置目录保留的 Claude Code / Desktop Code 日志；不包含未落地的普通云端聊天或已删除历史。
- 总 Token = 普通输入 + 缓存读取 + 缓存写入 + 输出。采用日志用量，不按可见文本长度猜测。
- 按实际响应标识合并流式片段，跨文件去重；复制、fork 和子代理中重复出现的同一响应不会重复计费。
- 已发生、后来移出上下文的请求仍计入。fork 继承记录优先采用可验证的原始日期；缺失原始时间时显示覆盖缺口，
  不把 fork 时间冒充计费时间。
- 日志损坏、超大记录、用量缺失、未知模型及缓存保留时间不明均会提示缺口；美元仅合计已定价部分。
- 多台机器分别查看，不直接相加，避免跨机器复制日志造成重复计费。

## API 等值费用

采用 **2026-11-17 的公开 Standard API 价格**。普通输入、缓存读取、5 分钟/1 小时缓存写入和输出分别定价。
支持的模型和精确 ID 见 [定价依据](docs/pricing-evidence.md)；未识别的 ID 保留 Token 并标为未定价。

这是按该价格表折算的美元，不是订阅账单或历史发票；历史日期也使用这张价格表。
不推算 Fast、Batch、地区溢价、合同折扣、税费或搜索等工具单独收费。
来源：[Anthropic 官方价格](https://platform.claude.com/docs/en/about-claude/pricing)、
[缓存计费](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。

## 数据和远程

原始日志只读。解析在按需启动的 worker 中完成；缓存只保存散列标识、时间、模型和用量，不保存聊天正文。
运行端的 `$CLAUDE_CONFIG_DIR/.daily-usage/` 保存机器标识和最近汇总；用量缓存位于 Claude++ 的
`tweak-data/com.kpk.daily-usage/cache`。

远程机器自己读取日志和计算，通过当前已认证的 Claude Remote Control 会话传输压缩后的数值汇总。
此 tweak 不请求远程原始日志，不增加通用文件读取/执行权限。查询与取消使用独立请求 ID；
原生只读状态应答作为事件通知，收到通知才读取一次对应的协议数据，没有定时读取结果。
协议数据及运行电脑的主机名位于独立的 `claudepp_daily_usage*` 元数据键，使用条件更新保留其他功能的数据；
查询结束或取消后清理自己拥有的键。日志与原始会话文件始终不修改。

原生 Remote Control 接口和会话绑定依赖 Claude 应用版本，升级后若不兼容会停止该远程功能并提示不可用。
Windows 是当前支持的运行端平台；跨平台 CI 不代表 macOS/Linux 原生进程发现已支持。

原生认证通道已在同一台机器上验证实际汇总返回、空闲停止和取消传播；查看端页面绑定在该测试中模拟。
两台物理机器的最终安装验收仍需在两端更新后进行，自动化 DOM 测试不代表人工界面验收。

## 开发

```powershell
npm ci
npm run build
npm test
npm run validate
npm run install:local
```

Renderer 没有 Node require；`npm run build` 将它嵌入 `index.js`。修改 renderer 后需要重新构建。
校验和开发安装默认使用同级 `../claude-plusplus` checkout，可用 `CLAUDE_PLUSPLUS_SOURCE` 指定。

一次性读取本机最近30天 JSON 报告：

```powershell
node scripts/report.cjs
```

可用 `--home PATH` 指定 Claude 配置目录、`--cache PATH` 指定缓存位置；默认 CLI 缓存写入
`<Claude 配置目录>/.daily-usage/cache`。命令结束后不保留后台任务。

源码：[kpkhxlgy0/claude-daily-usage](https://github.com/kpkhxlgy0/claude-daily-usage)。
MIT；复用来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
