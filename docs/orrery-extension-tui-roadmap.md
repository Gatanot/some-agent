# Orrery Extension and TUI Roadmap

> 调研结论：Orrery 保持 upstream pi 的 core 不变，只通过 extensions、themes、skills、prompt templates、pi packages 和 TUI 改进形成差异化。

## 1. 边界和判断标准

### 明确不动的部分

以下内容属于 upstream/core 能力，除非出现明确 bug，不建议在 Orrery 中继续修改：

- agent loop、消息调度、compaction 和 session 数据格式
- provider API、模型目录、认证和 OAuth
- 内置 read、write、edit、bash 工具的基础契约
- CLI 参数解析和非交互模式的输出协议
- RPC/SDK 的公共协议
- 为了品牌显示而修改 core 中的业务逻辑

### 允许修改的部分

- `.pi/extensions/` 或发布包中的 `extensions/`
- `themes/`、`skills/`、`prompts/` 和 pi package manifest
- `packages/tui` 中独立的组件、布局、渲染、输入和终端兼容性改进
- Orrery 自己的文档、示例、测试和发布检查脚本

### 选择功能的标准

一个功能优先进入 Orrery，需要同时满足：

1. 能独立作为 extension 或 TUI 组件启停。
2. 不改变已有 session、provider、tool 的语义。
3. 失败时能降级为普通文本、普通命令或默认 TUI。
4. 能用本地测试、fixture 或假 provider 验证。
5. 对日常编码任务有持续价值，而不只是启动页装饰。

## 2. 本地项目能力盘点

当前 pi 已经提供了较完整的扩展 API：

- 生命周期：`session_start`、`session_shutdown`、`before_agent_start`、`context`、`turn_start/end`、`agent_start/end/settled`
- 工具中间件：`tool_call` 可阻止或修改调用，`tool_result` 可处理结果
- 自定义能力：`registerTool`、`registerCommand`、`registerShortcut`、`registerFlag`
- TUI：`setHeader`、`setFooter`、`setStatus`、`setWidget`、`custom()`、overlay、custom editor
- 持久化：`appendEntry`、`registerEntryRenderer`、session name、entry label
- 资源：动态发现 extensions、skills、prompts、themes
- 现成示例：plan mode、subagent、permission gate、git checkpoint、custom footer、message renderer、Doom overlay 等

这意味着 Orrery 不需要再实现一套 agent framework。更合适的方向是把多个小扩展组合成一个有一致视觉和操作模型的个人工作台。

### 当前分支已经做的事情

- 已经将包品牌切换为 `@gatanot/orrery`。
- 已经有 Orrery 启动 logo 的尝试。
- 已经加入 Sixel 图片支持，扩展了 Windows Terminal 等环境中的图片展示能力。
- 已经有 plan mode 等扩展示例可作为产品功能基础。

注意：仓库里仍有 upstream 文档和 README 片段，品牌落地时应先统一用户可见入口，但不要为此改动 core。

## 3. 同类项目调研

### OpenCode

来源：

- [OpenCode README](https://github.com/anomalyco/opencode/blob/dev/README.md)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)

值得借鉴的产品层做法：

- `build` 和 `plan` 是清晰的工作模式，权限边界跟模式绑定。
- 使用子代理处理复杂搜索和多步骤任务。
- 插件承担工具、事件、权限和外部集成。
- 终端之外还有桌面应用和多端入口，但这些不属于 Orrery 当前范围。

对 Orrery 的启示：模式、权限和状态应该在 TUI 中一眼可见；复杂能力通过可选 extension 提供，不应硬塞进默认流程。

### Claude Code

来源：

- [Claude Code README](https://github.com/anthropics/claude-code/blob/main/README.md)
- [Claude Code plugins](https://github.com/anthropics/claude-code/tree/main/plugins)

值得借鉴的产品层做法：

- 插件可以提供 commands、agents 和领域工作流。
- `/bug` 等命令把反馈和诊断做成产品内流程。
- 文档、插件目录和社区入口共同组成生态，而不仅是一个 CLI 二进制。

对 Orrery 的启示：每个特色能力都应有独立命令、清晰状态、可禁用方式和最小文档；扩展包的安装、审查和版本固定同样重要。

### Aider

来源：

- [Aider README](https://github.com/Aider-AI/aider/blob/main/README.md)
- [Aider linting and testing](https://aider.chat/docs/usage/lint-test.html)
- [Aider Git integration](https://aider.chat/docs/git.html)
- [Aider voice usage](https://aider.chat/docs/usage/voice.html)

值得借鉴的产品层做法：

- Git 操作和恢复路径是核心体验，而不是事后补救。
- 每次修改后自动运行 lint/test，并把失败结果反馈给 agent。
- 图片、网页和语音都是可插拔的上下文输入。

对 Orrery 的启示：最有价值的特色不是再做一个聊天界面，而是让“修改、验证、回滚、审查”形成可观察的闭环。

### 调研后的取舍

建议借鉴这些项目的工作流，不直接复制它们的 core 设计：

- 借鉴：plan/read-only、权限门禁、Git checkpoint、测试反馈、状态面板、插件生态。
- 暂缓：桌面客户端、内置 MCP 平台、重型后台任务系统、provider 级路由改造。
- 保持差异：Orrery 以终端、可组合扩展和可恢复工作流为中心，TUI 是主要产品表面。

## 4. 建议的产品定位

**Orrery = 一个以“可观察、可恢复、可审计”为核心的个人终端 coding cockpit。**

这个定位比单纯换 logo 更有辨识度：

- 可观察：当前项目、分支、模型、工具、上下文和任务进度始终可见。
- 可恢复：每轮修改都有 checkpoint、session branch 或明确的回滚路径。
- 可审计：危险操作、测试结果、发布前检查和外部调用都留下可读记录。

品牌视觉可以围绕“轨道、节点、观测仪表”表达，但视觉只服务于状态层级，不应变成大面积装饰。

## 5. 优先级路线图

### P0：品牌基础和稳定工作台

#### 5.1 Orrery 主题包

**实现方式：theme package，必要时配合一个很小的 header extension。**

内容：

- 深色主题：黑/暖白为基础，使用金色作为主 accent，使用青色或绿色表达可操作状态。
- 浅色主题：降低黄色饱和度，保证 markdown、diff、warning 和 error 的对比度。
- 统一 logo、标题、选中态、工具边框、thinking level 和 diff 颜色。
- 提供 `orrery-dark.json`、`orrery-light.json`，支持热加载。
- 不在组件里预先缓存带 ANSI 颜色的字符串；遵守 TUI 的 `invalidate()` 规则。

验收：

- 51 个必需颜色 token 全部定义。
- 终端宽度 60、80、120 列均无溢出。
- dark/light、Kitty/Sixel/普通 ANSI 均有合理降级。
- 主题只需通过 package 或 `.pi/themes` 启用，不改 core。

#### 5.2 品牌化 header/footer/status

**实现方式：extension。**

建议显示：

- header：Orrery logo、版本、当前工作目录和已加载资源数量。
- footer：分支、session 名称、模型、thinking level、context 使用率、成本/usage。
- status：`plan`、`review`、`checkpoint`、`tests` 等短状态。
- 小屏幕隐藏次要字段，只保留模型、分支和当前状态。

不要做：

- 每次刷新都输出大型图片。
- 用不可配置的快捷键硬编码交互。
- 用一整块浮动卡片包住主界面。

### P1：最有价值的扩展能力

#### 5.3 Project Cockpit

**实现方式：extension + TUI widget/overlay。**

命令建议：`/cockpit`，快捷键可配置。

展示：

- 当前目录、Git 分支、dirty 状态和最近一次提交。
- 项目类型、包管理器、workspace 包数量。
- 可检测到的 lint、typecheck、test、build 命令。
- AGENTS.md/CLAUDE.md、skills、extensions、themes 的加载摘要。
- 当前 session 的 token、成本、工具调用和最近失败。

实现策略：

- 启动时只收集轻量信息。
- Git 和文件扫描使用缓存并在 command/widget 触发时刷新。
- 复杂扫描放进自定义 tool 或 command，不放在每个 `before_agent_start` 中。
- 所有数据都以“未检测到”降级，不阻塞模型请求。

这是 Orrery 最适合先做的特色功能，因为它把现有 footer、session API、资源 API 和 TUI overlay 组合成完整体验。

#### 5.4 Verification Loop

**实现方式：extension，优先使用现有 `tool_call`、`tool_execution_end`、`agent_settled` 事件。**

命令建议：`/verify`。

功能：

- 根据项目探测结果选择 typecheck、lint、unit test 等命令。
- `/verify` 手动执行；可选地在 `agent_settled` 后提示用户执行。
- 记录命令、退出码、耗时和截断后的输出。
- 将失败摘要作为可见 extension message，同时可选择作为 follow-up 交给 agent。
- 用 `ctx.signal` 支持取消，避免后台进程失控。

建议先做显式命令和“完成后提示”，不要默认每轮自动运行全套测试。全自动模式应作为项目级 opt-in 配置，避免大型项目每次回答都产生高延迟。

#### 5.5 Git Checkpoint and Recovery

**实现方式：extension，参考仓库已有 `git-checkpoint.ts` 和 `auto-commit-on-exit.ts` 示例。**

命令建议：`/checkpoint`、`/restore-checkpoint`、`/diff-checkpoint`。

功能：

- 在用户确认后创建轻量 checkpoint，记录 session entry id 和 Git 状态。
- `/diff-checkpoint` 显示 checkpoint 以来的变更摘要。
- `/restore-checkpoint` 必须显示将被覆盖的文件并要求确认。
- fork/tree 时保留 checkpoint 元数据，使用 `appendEntry` 持久化。
- 不自动 stash 用户未提交的无关修改。

关键风险：Git 工作区可能包含用户自己的变更。任何 restore、reset、checkout、clean 都必须区分 Orrery 产生的变更和用户原有变更，默认拒绝有歧义的恢复操作。

#### 5.6 Guardrails Pack

**实现方式：extension，仅拦截和确认，不修改内置工具契约。**

建议保护：

- `.env*`、密钥文件、SSH 配置、生产配置。
- `node_modules`、`.git`、构建输出和大文件目录。
- `rm -rf`、`git reset --hard`、`git clean`、force push、数据库迁移。
- 发布命令、凭据读取、向外部 URL 上传内容。

交互：

- 显示命令、受影响路径、风险原因和建议的 dry-run。
- 支持项目级 allowlist，但项目配置必须经过 trust 流程。
- print/json/rpc 模式不调用交互 UI；采用明确的拒绝或 CLI 可配置策略。

不要把 guardrail 做成永久不可绕过的黑名单。用户应能通过一次明确确认或可信项目配置处理合法例外。

### P2：提高复用率的扩展生态

#### 5.7 Review Desk

**实现方式：extension + overlay + entry renderer。**

命令建议：`/review`。

工作流：

1. 读取当前 diff 和 checkpoint 信息。
2. 让模型或用户选择 review 重点：正确性、安全、性能、测试、API 兼容性。
3. 将发现按严重性显示，并支持跳转到文件/行。
4. 保存 review 结果为 session entry，后续可以在 `/tree` 中回看。
5. 提供“生成修复任务”按钮，将选中问题放回 editor 或作为 follow-up。

不建议一开始实现完整 IDE 式文件跳转。先实现稳定的 diff 摘要、问题列表和可复制路径。

#### 5.8 Session Observatory

**实现方式：entry renderer + footer/widget + `/sessions` command。**

展示：

- session 时间线、分支、bookmark、fork/clone 关系。
- 每轮模型、耗时、工具调用、失败和 token 使用。
- 可搜索和筛选“有修改”“有错误”“有 checkpoint”的 session。
- 以 `appendEntry` 保存扩展元数据，不改变 session format。

这是 Orrery 与普通 CLI 拉开差距的长期能力：它把一次性对话变成可回溯的工程记录。

#### 5.9 Context Lens

**实现方式：extension command + overlay。**

命令建议：`/context`。

显示：

- 当前 system prompt 的来源摘要。
- 生效的 context files、skills、prompt templates 和 tools。
- 估算 token 占用和最近 compaction 的影响。
- 当前 turn 中哪些内容被 extension 注入或过滤。

必须避免直接在界面中泄露敏感的完整 prompt 或凭据。默认显示来源、大小和摘要，按用户操作展开详细内容。

#### 5.10 Remote and Sandbox Profiles

**实现方式：extension；参考现有 `ssh.ts` 和 `sandbox/` 示例。**

命令建议：`/profile`。

支持：

- 本地、SSH、容器或 Gondolin profile。
- 显示当前执行目标和路径映射。
- profile 切换前确认，切换后在 footer 中持续显示。
- 只将执行层替换为 profile 的 operations，不修改 agent core。

优先级低于 Guardrails，因为错误的远程 profile 会让用户误判实际修改位置。

### P3：可选的体验实验

#### 5.11 Voice / Clipboard / Screenshot bridge

Aider 已经证明语音、网页和图片上下文有价值。Orrery 可以用 extension 接入本地命令：

- `/screenshot`：从终端或桌面工具取得截图并附加到下一条 prompt。
- `/voice`：调用用户配置的本地转写命令，将结果写入 editor。
- `/clip`：将最后一个 assistant 结果或 review 发现复制为 issue/PR 内容。

这些功能必须依赖用户明确配置的本地命令，不在默认 extension 中上传数据，也不强依赖某个云服务。

#### 5.12 Wait Screen / Mini tools

保留游戏或动画作为可选 package，而不是默认体验。Doom、Snake 等现有示例适合测试 TUI overlay、键盘输入和刷新性能，但不应占据 Orrery 的产品主线。

## 6. TUI 专项建议

### 6.1 优先修的基础能力

1. **响应式信息密度**：为 header/footer/widget 建立窄屏、中屏、宽屏三个布局档位。
2. **Overlay 生命周期**：统一 focus、escape、dispose、重绘和窄屏隐藏行为。
3. **Diff/Review 组件**：提供稳定的文件名、行号、严重性和折叠结构。
4. **图片协议降级**：继续完善 Kitty、iTerm2、Sixel、truecolor half-block 和纯文本 fallback 的测试矩阵。
5. **状态动画规范**：统一 loader、working indicator、成功/失败状态，避免每个扩展自定义一套节奏。
6. **可访问性和兼容性**：控制 ANSI 宽度、CJK 宽度、IME cursor、256 色和无图片终端。

### 6.2 不建议现在做的 TUI 改造

- 重写整个 renderer 或 differential rendering 机制。
- 引入复杂的全屏 dashboard 替代聊天主界面。
- 为每个 extension 增加独立浮动 card 风格。
- 依赖 Unicode 图标而没有 ASCII/纯文本等价物。
- 为了展示指标而持续启动后台 watcher、socket 或 timer。

## 7. 建议的 package 组织

建议最终发布一个 Orrery 体验包，而不是把所有能力散落在个人目录：

```text
orrery-experience/
├── package.json
├── extensions/
│   ├── cockpit.ts
│   ├── verification-loop.ts
│   ├── git-checkpoint.ts
│   ├── guardrails.ts
│   ├── review-desk.ts
│   └── session-observatory.ts
├── themes/
│   ├── orrery-dark.json
│   └── orrery-light.json
├── skills/
│   ├── review/
│   │   └── SKILL.md
│   ├── release-audit/
│   │   └── SKILL.md
│   └── project-onboarding/
│       └── SKILL.md
└── prompts/
    ├── review.md
    └── release-audit.md
```

manifest 示例：

```json
{
  "name": "@gatanot/orrery-experience",
  "keywords": ["pi-package", "orrery", "coding-agent"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

安装时使用固定版本，例如：

```bash
pi install npm:@gatanot/orrery-experience@0.1.0
```

扩展包具有完整系统权限。发布前必须审查依赖、网络请求、shell 命令和路径处理；运行时依赖应放在 `dependencies`，不要只放在 `devDependencies`。

## 8. 实施顺序

### Milestone 1：品牌工作台

- [ ] Orrery dark/light themes
- [ ] 品牌化 header/footer/status extension
- [ ] 窄屏和无图片终端回退测试
- [ ] 安装、启用、禁用和 `/reload` 文档

### Milestone 2：可恢复编码闭环

- [ ] Guardrails Pack
- [ ] Git checkpoint/recovery
- [ ] Verification Loop
- [ ] 对危险命令、用户原有 dirty changes 和取消行为增加测试

### Milestone 3：差异化 TUI

- [ ] Project Cockpit overlay
- [ ] Review Desk
- [ ] Diff/review 基础组件
- [ ] Sixel/Kitty/ANSI/CJK/窄屏截图或虚拟终端测试

### Milestone 4：可回溯工程记录

- [ ] Session Observatory
- [ ] Context Lens
- [ ] checkpoint、review、verification 的 entry renderer
- [ ] 导出为 Markdown/JSON 的报告命令

### Milestone 5：可选集成

- [ ] Remote/Sandbox profiles
- [ ] Screenshot/voice bridge
- [ ] 社区可安装的独立 package

## 9. 测试和质量门槛

每个 extension 至少覆盖：

- 正常路径和取消路径。
- 没有 UI 的 print/json/rpc 模式。
- session resume、fork、tree 后的状态恢复。
- extension reload 后的资源清理。
- 用户已有 Git 修改时的保护行为。
- 命令失败、超时、输出截断和 AbortSignal。

每个 TUI 组件至少覆盖：

- 60、80、120 列宽度。
- CJK 文本和长路径。
- ANSI 颜色、256 色、truecolor。
- 无 Kitty/Sixel 图片能力时的 fallback。
- overlay focus、Escape、dispose 和主题热加载。

仓库级验证继续使用：

```bash
npm run check
```

新增测试文件后运行对应的单个测试，不直接依赖完整 vitest suite。不要为了实验功能修改 core 测试契约。

## 10. 最终建议

最值得先实现的是：

1. Orrery theme + header/footer，建立统一视觉身份。
2. Project Cockpit，让当前项目和 agent 状态可观察。
3. Guardrails + Git checkpoint + Verification Loop，建立可审计、可恢复的修改闭环。
4. Review Desk 和 Session Observatory，把 TUI 从聊天输出提升为工程记录界面。

不建议先投入桌面端、provider 路由、MCP 平台或大规模 core 重构。Orrery 的优势应来自一组小而可靠的扩展和一套克制、信息密度高、终端兼容性好的 TUI。
