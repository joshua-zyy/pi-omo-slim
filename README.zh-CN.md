# pi-omo-slim

[English](README.md) · [简体中文](README.zh-CN.md)

![pi-omo-slim — 连接六个专家 Agent 的 Pi 编排器](assets/pi-omo-slim-banner.png)

针对 [Pi](https://github.com/earendil-works/pi) 的轻量级 OMO-slim 风格编排配置。

本仓库中的 Orchestrator 与专家 Agent 提示词是持续演进的文档：会随日常使用中发现的问题不断优化与更新，因此新安装副本的行为可能领先于旧副本。如需获取提示词更新，请重新执行安装器的 `plan`/`apply` 流程。

`pi-omo-slim` 为 Pi 提供一个面向工作流的 Orchestrator（编排器）与六个专注的专家 Agent：

- **Explorer** — 本地代码库侦察；
- **Librarian** — 外部文档与库研究；
- **Oracle** — 架构、调试策略、评审与简化；
- **Designer** — UI/UX 设计、评审与实现；
- **Fixer** — 有界的非视觉实现；
- **Verifier** — 对已完成实现工作的独立评审与有界验证（通常是 Fixer 的产出）；
- **Council** — 手动调用的多议员共识评审，用于高价值判断题（`/council`），把 OMO-slim 的 council 概念适配到 Pi 的 subagent API。

本项目是一个配置包。它不 fork Pi、`pi-subagents` 或 OMO-slim，而是把 OMO-slim 的角色边界与编排方法适配到 Pi 实际提供的扩展与子 Agent API 之上。

## 环境要求

- Pi；要求 **>= 0.84.0**，因为强制依赖的 `@tintinweb/pi-subagents` 0.19.0 声明了 Pi >= 0.84.0 的依赖；安装器会在 `plan` 阶段强制此下限，更低的 Pi 会被 fail-closed 拒绝。本次发布以 **0.84.2** 完成集成验收（仓库的 `@earendil-works/pi-coding-agent` dev dependency 不因此修改）；
- 以下 Pi 包：
  - `@tintinweb/pi-subagents` — **>= 0.19.0**：本项目任务派发基线所测试的版本（低于 0.18.2 的版本虽能通过协议 ping，但缺少 RPC 派发路径的模型范围校验），安装器会在 `plan` 阶段强制此下限
  - `@ff-labs/pi-fff`
  - `pi-web-access`
  - `pi-lens`
  - `@firstpick/pi-extension-safety-guard`
  - `@narumitw/pi-chrome-devtools`
  - `@narumitw/pi-goal`
  - `@tintinweb/pi-tasks` — **>= 0.9.0**：Orchestrator 任务契约所依据并测试的版本，安装器会在 `plan` 阶段强制此下限

本仓库中的 Agent 模板不固定模型或思考级别。默认情况下，它们继承父 Agent 的这些设置。安装期间，你可以选择全部继承、为六个角色统一应用一份共享配置，或为每个角色单独配置。任何固定的模型都必须选自你当前 Pi 环境中可用的模型。安装 Agent 只修改写入你 Pi 配置目录的副本，绝不修改本仓库中的源模板。

## 推荐安装方式

在任意目录中打开 Pi，输入以下提示词。你无需自行克隆仓库：

```text
从 https://github.com/joshua-zyy/pi-omo-slim 安装 pi-omo-slim。首先询问我仓库应该克隆到哪里。在克隆之前，向我展示确切的目标路径和 git clone 命令，并等待我的明确批准。未经检查并获得单独批准，不得覆盖或更新已有目录。克隆完成后，完整阅读本地克隆中的 INSTALL_AGENT.md 并严格遵循其步骤。批准克隆并不等于批准修改我的 Pi 配置。在向我展示 INSTALL_AGENT.md 要求的准确目标、备份方案和命令，并且我批准最终安装方案之前，不得修改我的 Pi 配置。
```

Agent 会询问仓库的存放位置，在获得确切克隆命令的批准后，再从本地安装指南继续。该指南以 `scripts/install.mjs` 作为唯一确定性入口：Agent 编写一份封闭式请求，生成不可变计划，展示其操作、自动回滚范围与 SHA-256 供你明确批准，然后执行一次 `apply` 命令。备份、写入、验证与失败回滚均由固定的跨平台 Node.js 安装器实现，而不是由 Agent 自写的 shell 命令完成。

仓库克隆与 Pi 配置安装是两个相互独立的批准检查点。批准克隆并不授权任何 Pi 配置变更。

## 确定性安装概要

先分别安装上述八个必需包，再制定计划；`plan` 会强制 Pi >= 0.84.0、`@tintinweb/pi-subagents` >= 0.19.0 与 `@tintinweb/pi-tasks` >= 0.9.0 的下限。随后创建 `INSTALL_AGENT.md` 中记载的封闭式 `request.json`，并运行：

```text
node scripts/install.mjs plan --request <absolute-request.json> --config-root <absolute-config-root>
node scripts/install.mjs apply --plan <absolute-plan.json> --sha256 <approved-plan-sha256>
```

审查生成的计划，并在 `apply` 之前批准其确切 SHA。安装器会备份最新的执行时状态，只写入已批准的目标，执行固定验证，并在失败时自动回滚由事务创建或替换的文件。计划、备份、结果与回滚报告均保留在 Pi 配置根目录下，便于审计。

默认的全局配置目录为 `~/.pi/agent`。若设置了 `PI_CODING_AGENT_DIR`，Pi 将使用该环境变量指定的目录。

不要手工编辑生成的计划，也不要静默覆盖同名自定义 Agent。当选项或已批准的替换冲突发生变化时，请重新生成新计划。

安装完成后，用 `/orchestrator on` 启用 Orchestrator Mode，然后发送 `ping all agents` 做一次冒烟测试。六个专家 Agent 会被并行派发：

![六个专家 Agent 被并行派发，各自在后台运行](assets/pingAllAgents_ex_1.png)

随后它们逐一回应，确认六个角色齐备，且 Orchestrator 已就绪可以开始路由工作：

![六个 Agent 全部回应 pong，Orchestrator 报告在线](assets/pingAllAgents_ex_2.png)

## 命令

```text
/orchestrator          切换模式
/orchestrator on       为当前会话分支启用
/orchestrator off      禁用
/orchestrator status   显示当前状态
/orchestrator doctor   诊断策略、agent 文件与工具选择器
/lanes                 显示专家泳道实况（子代理活动看板）
```

可选的全局配置文件为 `<config-root>/orchestrator-mode.json`：

```json
{
  "defaultEnabled": true
}
```

`defaultEnabled` 仅影响本 Orchestrator Mode 扩展，不会启用或禁用任何其他 Pi 扩展。当该文件或属性不存在时，全局默认值为 `false`。无效的 JSON 或非布尔值会产生警告，并同样回退为 `false`。扩展会在加载时读取一次 `extensions/orchestrator-mode/orchestrator-policy.md` 和 `extensions/orchestrator-mode/orchestrator-goal-policy.md`；仅当当前会话分支存在活跃的原生 Goal 时，才注入 Goal addendum。编辑这些文件后，运行 `/reload` 或重启 Pi，让扩展重新加载它们。

生效状态的优先级为：当前会话分支中最近一次显式状态，其次 `defaultEnabled`，最后 `false`。因此，当 Pi 打开新会话或切换到未记录模式状态的会话时，`defaultEnabled: true` 会启用该模式；而曾执行过 `/orchestrator on` 或 `/orchestrator off` 的会话分支则保留其显式状态。

扩展还会把各 agent 的 `ext:` 工具选择器与会话实际提供的工具做一次审计。该审计在首个 agent 回合运行，而不是会话启动时：pi-fff 等扩展在自身的 `session_start` 处理器里注册工具，过早审计会把稍后才注册的工具误报为缺失。确实缺失的工具只警告一次；`/orchestrator doctor` 可随时查看完整报告。

### 泳道看板

`/lanes` 按需显示已观察到的顶层子代理事件快照：完整 agent ID、角色、事件状态、耗时、目标、steer 次数，以及 token/结果摘要。无论 Orchestrator Mode 是否开启它都可用；`/orchestrator doctor` 也会包含事件状态概要。同一 ID 恢复执行时视为新一轮运行，替换上一轮的计时、结果、错误和 steer 计数。

看板是构建在 pi-subagents 生命周期事件之上的只读观察者，从不派发、改道或消费代理。显示的状态和数量来自事件；渲染时，注册表与事件的差异会单独标注，而不是悄悄改写事件历史。注册表不可用、查询失败、记录无效和查无指定代理会分别标为未知状态，不能据此认定执行已经停止。

终态注册表记录可能带有通知消费标志。前台直接返回结果、`get_subagent_result` 和 RPC 消费均可设置它。它**不代表验收通过**，不能识别具体交付路径，也不能证明通知从未发送。标志缺失也不证明结果被忽略。

诚实声明的边界：

- 这是按需查看命令，**不是卡死检测器**：仍登记为 running 的代理可能正常推进，也可能已经卡住。没有心跳、超时、自动唤醒、取消或重派机制。
- Orchestrator Mode 开启时，看板还会在每次 LLM 调用前，把一份有界的会话内快照注入模型上下文——这正是缓解 Orchestrator 压缩后记账问题的部分。快照以不显示的 custom 消息只写入该次调用的上下文副本：不产生额外回合、不写入会话条目、不注册工具、也不持久保存任何内容；下一次调用都会基于本次激活的内存事件重建，并替换上一份副本。模式关闭或看板为空时不注入，且旧的快照仍会被移除。即使可见历史被压缩为只剩摘要，下一次调用仍会带上当前快照。
- 快照列出完整 agent ID、有界的 `type`/`description` 标签、事件状态，以及每条泳道独立的注册表观察（kind，record 时附 status 和已知的通知消费标志）。事件或登记状态显示 queued/running 的泳道优先；终态泳道按完成时间从新到旧排列，同毫秒按原插入倒序。它刻意不含结果与错误正文、prompt、steer 消息、token 账单或工作区验收结论。标签按不可信数据做 JSON 转义，说明中明确指出它们不是指令：请用原生工具取结果并自行验收交付物。注册表 `running` 依然只代表已登记，通知被消费依然不代表验收。
- 注入受两个固定上限约束：最多 20 行，说明加 JSON 合计最多 6000 个 UTF-16 字符。超长标签会带截断标记（`type` 64 字符、`description` 160 字符），但 ID 永不截断：放不下的整行省略，因此超长 ID 不会挤掉后面的短 ID。`counts.shown`/`counts.omitted` 与 `partial` 标志始终准确，即使所有行都被省略，JSON 仍可解析。
- 每次扩展激活都从空看板开始，内存中只保留每个 ID 最近观察到的运行，不重建历史，也不按 `/tree` 分支重建独立看板。事件订阅在 `session_start` 建立，在 `session_shutdown` 移除。
- 嵌套子代理与 workflow 的子代理不产生生命周期事件，保持不可见；它们经由各自的所有者汇报。
- pi-subagents 可能驱逐已结束的代理记录；通知消费标志只在记录存活期间可读。命令使用 Pi 的通知 UI，在 print/JSON 模式下不显示。

## Council

`/council` 是手动调用的共识评审，用于高价值的判断题——架构选择、方案取舍、评审。它刻意是本套件中最昂贵的路径，永远不会被自动触发：必须由你输入命令。

```text
/council 这次迁移选 job queue 还是 outbox 模式？
/council doctor
```

命令读取 `<config-root>/council.json` 中的名单（每次调用都重新读取，改配置无需 reload），注入一条 council 指令。主会话作为综合者：组装一份共享信息包，前台并行派发全部议员，然后裁决出一份报告：

1. **Council 结论** —— 综合者裁决后的推荐（council 提供建议，裁决权在综合者）；
2. **共识摘要** —— 一致点、分歧点及裁决理由、剩余不确定性，以及 `unanimous` / `majority` / `split` / `insufficient` 共识度评级（仅按有效回应计数，并注明分母）；
3. **各议员意见** —— 每位有效议员的结论、关键理由与置信度，标注名单名与模型；
4. **参与情况** —— `N/M responded`，注明缺席者与失败原因。

名单每一项包含 `name`（字母、数字、`_`、`-`）、可选 `model`（留空或缺省即继承父会话模型）、可选 `thinking` 级别、可选视角 `prompt`：

```json
{
  "councillors": [
    { "name": "skeptic", "model": "", "prompt": "Examine failure modes, edge cases, and risks." },
    { "name": "architect", "model": "", "prompt": "Examine maintainability, boundaries, feasibility, migration path, and long-term cost." },
    { "name": "minimalist", "model": "", "prompt": "Compare against the smallest designs that still meet the requirement." }
  ]
}
```

如实声明的边界：

- 安装的 `agents/councillor.md` 模板永不固定 `model` 或 `thinking`：pi-subagents 以 agent 文件 frontmatter 优先于派发参数，因此 `council.json` 是逐议员模型的唯一来源。自定义 keep/replace 模板违反此约束或强制后台派发时，`/council doctor` 会警告。
- 默认名单为三个同模型议员。同模型议员之间的一致意见不构成独立验证；综合者必须明确说明这一点。
- 降级如实：失败议员记为缺席（不自动换模型）；仅一份有效回应时标注为“单份意见”而非共识；零有效回应时报告召集失败——不制造共识。
- 综合者就是主会话：裁决质量受你的会话模型限制。需要更强的裁决能力时，请切换会话模型。
- 报告只存在于对话中；会话压缩不保证完整保留。需要留存时请要求综合者写入文件。
- `/council doctor` 只检查全局模板与全局 `council.json`；项目级 `.pi/agents/councillor.md` 覆盖（Pi 原生机制）不在检查范围，模型注册表存在也不保证派发成功。
- `/council` 需要交互式会话。print 模式（`pi -p`）下命令会执行但不会召集议会——注入的指令没有可依附的交互回合。

## Goal 集成

`@tintinweb/pi-tasks` 是固定依赖，安装后所有模式都会获得其原生任务工具与默认 guidance。其配置文件 `tasks-config.json` 完全由用户自行管理：本项目从不创建或修改该文件，也不依赖或改动 `autoCascade`（上游默认关闭）等选项。

Goal 始终由用户显式启动。你必须显式运行 `pi-goal` 原生命令，例如：

```text
/goal <objective>
/goal --tokens 100k <objective>
```

Orchestrator 永远不会自动启动 Goal；本项目不提供 UltraGoal，也没有自动 Goal 转换。

- 默认模式下，`/goal` 只遵循 `pi-goal` 原生工作流，不应用 Orchestrator 的 Wave 纪律。
- Orchestrator Mode 下，`/goal` 保持 `pi-goal` 原生语义，并额外倾向把可独立进行的工作拆成并行的后台专家 lane，同时提供单一当前 Wave 检查点、后台 subagent 等待协调与既有风险路由。

Orchestrator 只保留当前 Wave/阶段检查点，并按实际委派的工作单元创建执行任务；它从不手工复制 subagent 实时状态，实时状态仍以 Pi 的 Agent 与任务工具为准。任务到达完成态本身并不等于验收通过——只有核对过实际工作区之后，结果才会被接受。Orchestrator policy 是提示词层面的行为约束，不是替代 `pi-goal` 或 `pi-tasks` 运行时校验的强制状态机。

`pi-goal` 的原生 token budget 只统计主会话分支中的 assistant 用量，不包含 Orchestrator 派出的独立 subagent 会话。本项目不聚合这些用量，`/goal --tokens` 也不是涵盖 specialist 消耗的总上限。lane 数量或 `max_turns` 不是 token 预算的替代品。

## 与 OpenCode 上 OMO-slim 的差异

本项目是适配版本，不声称具有完全的运行时对等性。Pi 的 `Agent`、`get_subagent_result` 与 `steer_subagent` 机制覆盖了主要工作流，但并未逐项复刻 OMO-slim/OpenCode 的每一项设施。尽管 `pi-subagents` 也提供 `resume`，本项目不依赖会话复用：仅当角色与 lane 不变且会话仍可解析时，Orchestrator policy 才复用已完成的专家，否则启动全新专家。具体而言，本项目不声称提供 OMO-slim 的后台任务板（Background Job Board）、唤醒调度器（Wake Scheduler）或完全一致的任务取消行为。

Designer 与 Fixer 可以写文件并运行 shell 命令。Oracle 与 Verifier 没有写文件工具，但可以运行有界的 shell 诊断或验证。Safety Guard 扩展是额外的生命周期防御，而非操作系统级沙箱，也不能替代用户批准与项目专属指令。

## 项目结构

```text
agents/                         七个 pi-subagents Agent 定义（六个专家 + councillor）
config/                         安装配置模板（含默认 council.json 名单）
extensions/orchestrator-mode/   模式与 council 命令、状态处理与策略
scripts/install.mjs             确定性的 plan/apply/verify/rollback 安装器
INSTALL_AGENT.md                Pi Agent 的安装流程
```

## 致谢与第三方声明

本仓库中的专家 Agent 提示词与 Orchestrator 策略改编自：

- 项目：[oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)
- 改编基线：2.2.13，commit `282d5f26a4ad2665118a73014fcf02e57869bd38`
- 许可证：MIT

上游版权声明与 MIT 条款保留在 [LICENSE](LICENSE) 中。

本项目要求用户自行安装（但不打包）以下独立维护的 Pi 包。项目准备期间，下列各测试版本均声明采用 MIT 许可证：

| Package | Tested version | Upstream repository |
| --- | ---: | --- |
| `@tintinweb/pi-subagents` | 0.19.0 | <https://github.com/tintinweb/pi-subagents> |
| `@ff-labs/pi-fff` | 0.10.3 | <https://github.com/dmtrKovalenko/fff> |
| `pi-web-access` | 0.21.0 | <https://github.com/nicobailon/pi-web-access> |
| `pi-lens` | 3.8.74 | <https://github.com/apmantza/pi-lens> |
| `@firstpick/pi-extension-safety-guard` | 0.2.7 | <https://github.com/Firstp1ck/pi-coding-agent-forge> |
| `@narumitw/pi-chrome-devtools` | 0.52.0 | <https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-chrome-devtools> |
| `@narumitw/pi-goal` | 0.51.0 | <https://github.com/narumiruna/pi-extensions> |
| `@tintinweb/pi-tasks` | 0.9.0 | <https://github.com/tintinweb/pi-tasks> |

这些依赖仍受各自上游许可证的约束。权威的许可证与声明以用户实际安装的版本所附带的为准。

`pi-omo-slim` 是一个独立的社区改编项目，与 OMO-slim、OpenCode、Pi 以及上列各包的维护者之间不存在隶属或背书关系。

## 许可证

MIT。参见 [LICENSE](LICENSE)。
