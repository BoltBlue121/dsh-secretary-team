## 安装（DSH Desktop 0.2.1+）

这是一个 DSH bundle：装好后，用 `secretary-standard` / `secretary-cordis` 预设开会话，得到"只读秘书 → 领导 → 团队"的完整编制。

### 前置条件

1. 本机已安装 **Claude Code CLI**（`claude --version`），并已登录（`claude` 里执行 `/login`），
   或准备好 `ANTHROPIC_BASE_URL` + 对应的凭据引用（见下方"配置"）。
2. DSH Desktop 版本 `>= 0.2.1-rc.3`（`package.json` 的 `engines.dsh` 会拦住更低版本）。

### 方式 A：从 Git 安装（推荐，可钉 commit）

```text
plugin_manager install_bundle target="github:BoltBlue121/dsh-secretary-team#<commit-sha>"
```

### 方式 B：从 tarball 安装

```text
plugin_manager install_bundle target="<解压或下载后的路径>/local-dsh-secretary-team-2.6.0.tgz"
```

### 配置

默认配置走 `claude` / `node`（PATH 解析）+ Claude Code 自带登录，**不需要改任何文件**。
需要钉版本、指定绝对路径、或走自己的网关时，在 profile 的 `cordis.patch.yml` 里用相同 id
`secretary-team-cc-runtime` 覆盖 `config`：

```yaml
- id: secretary-team-cc-runtime
  config:
    executablePath: 'C:\path\to\claude.exe'
    expectedSha256: '<64 位 sha256>'
    baseUrl: 'https://your-gateway.example'
    credentialRef: YOUR_CREDENTIAL_REF
```

注意：`expectedSha256` 留空表示每次启动不校验 CLI 哈希；`baseUrl` / `credentialRef`
留空表示不注入网关，直接用 Claude Code 自己的登录。

### 快速验证

装好后在秘书会话里应看到：秘书只有只读工具、能派 `delegate_leader*`；领导能派
`delegate_worker_*`；实现完成后领导必须派 `delegate_worker_verify` 做独立验收。

---

## v2.6.0 升级：秘书 ↔ 领导双向、多轮沟通

- **原生领导**（`delegate_leader_astra` / `delegate_leader_deepseek`，spawn provider，本来就是 DSH continuable 子代理）：秘书和领导预设挂上官方 `@deepseek-ai/dsh-tool-subagent-control`（行 id `adjacent-messaging`，避开 Agent Teams 层对 `tool-subagent-control` 的禁用）。秘书在领导运行中或结束后都能 `send_message({ agent_id, message })` 继续说话、`interrupt_agent` 叫停；领导可以中途用 `send_message` 向秘书汇报或提问。投递对象只能是直接子代理或直接父代理，由 `ctx.subagents.sendMessage` 校验。
- 新入口 `boundary-messaging`：与 `boundary` 相同，只多放行标准形态（参数为 `agent_id`）的 `send_message` / `interrupt_agent`；Agent Teams 形态（参数为 `target`）以及其它团队/派生工具仍拒绝。成员、验收、调研、方案预设保持严格的 `boundary`，并且不挂这个消息工具（团队保持扁平）。
- **Claude CLI 领导**（`delegate_leader`）：外部进程按官方契约无法成为 continuable。实现方式改为：领导会话持久化（首轮用 `--session-id`，续接用 `--resume`），每轮成功交付末尾附一行「续接编号」。秘书再次调用 `delegate_leader`，第一行写 `[续接 <编号>]`，即可回到同一个 Claude 会话。续接只限发起它的秘书本人、只限相同 cwd、不能并发；编号未知时 fail-closed。编号写入续接台账，bundle 重载、桌面端重启后 7 天内仍可续接。worker / review 角色仍是一次性的。
- 人格同步：秘书新增「跟领导来回沟通」一节，仍要求原话转达、不添油加醋；领导可以向秘书提问，CLI 领导被告知会被续接回来。
- 独立审查修正（只读审查员发现 2 个 should-fix、5 个 nit，无 blocker）：
  - CLI 领导派出的原生成员，在 DSH 里的直接父代理是秘书本人。为此，秘书预设改用 `boundary-secretary`，只放行秘书自己的领导，秘书不能绕过领导去指挥成员或验收员。领导预设仍用 `boundary-messaging`。
  - **兼容旧对话**：什么算"自己的领导"有两种判断。一是本次运行中 `delegate_leader*` 返回的 id；二是 DSH 持久化的秘书会话 `subagentCatalog` 里登记的直接子代理，其 label 不是 broker 成员的 `CC worker …`（这个 label 从第一个 CLI broker `6f2dc47` 起就没变过）。所以 2.6.0 之前派出的原生领导、桌面端重启后的领导都能继续对话。读不到 catalog 时一律拒绝（fail-closed）。
  - CLI 领导 2.6.0 之前的交付没有续接编号，人格要求改为重新派发自包含任务书。
  - **续接跨重载/重启**：续接编号写入 CLI 运行日志旁的 `cc-continuations.json`（见 `lib/cc-ledger.mjs`）。文件只存 id、所属秘书会话、cwd 和时间，不存任务内容和凭据，写入是原子的。bundle 重载或桌面端重启后仍可 `[续接]`，仍限同一秘书、同一 cwd。7 天未用的编号失效并删除对应 transcript。卸载不再删除 transcript。
  - 新增 `lib/cc-session.mjs` 清理领导会话的 transcript，只删 `<configDir>/projects/<dir>/<uuid>.jsonl` 和同名目录，不扫描其它会话。触发时机：首轮失败、被淘汰、卸载。Host 崩溃留下的孤儿文件不会自动清理。
  - 续接数量上限：每个秘书 16 条、全局 64 条。
  - `[续接]` 不在开头时报错 `CLI_CONTINUATION_MISPLACED`，不会悄悄当成新任务跑。
  - 结果对象异常时也会释放续接锁。
  - 续接后旧成员任务 id 失效，`leaderPrompt` 里已写明。
  - 原生领导用 `send_message` 只发进展和提问，最终交付只在最后一条回复里写一次。
- 测试：新增 `test/messaging.test.mjs`、`test/cc-session.test.mjs`；`cc-process` / `cc-provider` 测试补充续接与清理用例。`node test/run.mjs` 结果为 16/16。
- 状态：**未提交、未 reload**。需要在 Host 重新加载后做实机验证。

## v2.5.0 升级：审查修复（CLI 领导对齐团队、秘书不执行代码、验收只读不可绕过）


- CLI 领导（`delegate_leader`）的 broker 增加 verify / research / plan 路由，固定落到 team-verifier / team-researcher / team-planner；`leaderPrompt` 改为 team-leader 人格（必派验收、不自判通过、反向反馈、不退回秘书）。
- `secretary-gate` 拒绝 `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine`（tool-cordis 没有只读开关）。
- verify / research / plan 不再接受 `agent_preset`；新增 `preset/readonly-gate.mjs` 挂在三个只读角色预设上，机械拒绝 shell 写文件。
- 领导 → 秘书中途回传通道只做了设计，见 `docs/superpowers/specs/2026-11-09-secretary-team-route-options-design.md`。
- 2026-11-09 已发布 v2.5.0（GitHub release），Host 日志确认 `bundle 2.5.0` 已加载运行。


> 分发版说明：委派状态日志、CLI 运行日志和 CLI 领导续接台账（`cc-continuations.json`）默认放在系统临时目录的 `dsh-secretary-team/` 下。可用环境变量 `DSH_SECRETARY_TEAM_LOG`、`DSH_SECRETARY_TEAM_CLI_LOG` 改位置（台账跟随 CLI 运行日志所在目录）。系统清理临时目录后，旧续接编号会失效，秘书会改为重新派发。

## v2.4.1 升级：CLI runtime 可移植化（分发前置）

- host/claude-code.mjs 的配置改为“本机可钉、默认可空”：xecutablePath 默认 `claude`、
odeExecutablePath 默认 `node`、xpectedSha256 / configDir / aseUrl / credentialRef 可留空。留空时从 PATH 解析、跳过哈希校验、使用 Claude Code 自带登录；填了则保持原来的绝对路径 + SHA-256 + 网关 + 凭据行为。
- lib/cc-provider.mjs：只有同时配置 aseUrl 与 credentialRef 才解析凭据并注入 ANTHROPIC_*；否则不注入、不强制凭据。CLAUDE_CONFIG_DIR 只在配置了 configDir 时设置。
- 本地现网配置仍由 bundle 的 cordis.host.yml 显式钉住（绝对路径/哈希/网关），行为不变；公开分发包使用留空的通用配置。
- 已发布：GitHub BoltBlue121/dsh-secretary-team tag 2.4.1（含 tarball）。
# dsh-secretary-team

## v2.4 当前升级：完整团队编制 + DSH 标配 + 领导反向反馈

```text
用户 ↔ 秘书（只读；只负责来回对齐，不判通过）
          └→ 领导（Claude Code / Astra / DeepSeek）→ 团队
                       ├─ 实现：fast / stable / writing / backend / frontend
                       ├─ 调研：delegate_worker_research → team-researcher
                       ├─ 方案：delegate_worker_plan     → team-planner
                       ├─ 验收：delegate_worker_verify   → team-verifier（不能改代码）
                       ├─ DSH 标配：任意成员可传 agent_preset: standard
                       └─ 专用增编：cordis / comsol-sim / novel-writer / 画图
```

- **团队该有的角色都有**：实现五类之外，新增调研（`team-researcher`，只读 + web，给带来源的结论）与方案（`team-planner`，读现状出可执行拆分）两个只读角色；加上独立验收，构成"调研 → 方案 → 实现 → 独立验收"的完整链条。
- **DSH 标配也吃进来**：`standard`（DSH 自带完整代理）会被显式加入每个成员工具的可选预设，领导可以传 `agent_preset: standard` 直接用一个 DSH 原生代理当成员；注册表里读不到声明时自动跳过，不会拖垮挂载。
- **领导反向反馈**：领导人格新增"反向反馈"——阶段完成、卡点、需用户决策、验收结论都要主动回传秘书，只写事实与证据，不美化、不省略失败；和用户要求冲突时原样上报，不替用户拍板。
- 其余（独立验收、秘书只对齐、只读工具面、扁平团队）沿用 v2.3 / v2.2。

## v2.3 升级：独立验收 + 秘书只对齐不验收

```text
用户 ↔ 秘书（只读；只负责来回对齐，不判通过）
          └→ 领导（Claude Code / Astra / DeepSeek）→ 团队
                       ├─ fast / stable / writing / backend / frontend（实现）
                       ├─ delegate_worker_verify → team-verifier（独立验收，不能改代码）
                       └─ agent_preset：按需增编 cordis / comsol-sim / novel-writer / 画图
```

- **独立验收成员**：新增 `delegate_worker_verify` → `team-verifier` 预设。它没参与实现、只读 + 可跑验收命令，write/edit 在它自己的 scope 里被机械拒绝。领导实现完成后必须派它验收；它给"通过 / 不通过 / 证据不足"和逐条证据。
- **领导不再自己判通过**：人格改为"先基本核对，再派独立验收"；不通过按验收成员指出的失败点返工，最多两轮。需要 `cordis_inspect` 证据时给 verify 传 `agent_preset: cordis`。
- **秘书不验收**：只负责把用户的验收标准写进任务书、把结论与证据转述给用户、用户改要求时更新任务书。秘书的只读工具只用于理解上下文与转述。
- **对齐铁律（不添油加醋）**：用户原话、路径、数字、禁止项、优先级原样写进任务书；不替用户决定、不补验收标准；领导反问原样带回，用户回答原样带回；汇报时区分"用户要求的"和"团队做的"。
- **扁平不变**：验收成员也是叶子，递归派活照样被屏蔽；`team-verifier` 不会出现在其他成员的可选预设里。

## v2.2 升级：主 Agent 只读工具面（只准看不许干）

```text
用户 ↔ 秘书（只读：read/glob/grep + web + inspect；不能写、不能跑命令）
          ├─ delegate_leader            → Claude Code CLI（xindupx / Opus）
          ├─ delegate_leader_astra      → DSH 原生 GPT-6 Astra 工程领导
          ├─ delegate_leader_deepseek   → DSH 原生 DeepSeek Flash 工程领导（便宜、快）
          └─ 领导（干活主力）→ delegate_worker_*（可带 agent_preset）
                       ├─ 常备五类：fast / stable / writing / backend / frontend
                       ├─ 专用增编：cordis / comsol-sim / novel-writer / 画图等预设
                       └─ 成员一律是叶子：递归派活被强制屏蔽
普通会话：delegate_claude_code → 同一真实 CLI 领导
```

- **工具面直接阉割，不再只靠人格**：秘书预设不再挂 `tool-bash` / `tool-pwsh` / `tool-jobs` / `tool-schedule` / `command-goal` / `tool-goal` / plan-mode / `plugin_manager`；`tool-fs` 以 `write:false, edit:false` 挂载，只剩 `read` / `glob` / `grep`。写文件、跑命令、后台任务、定时任务、goal 这些工具**根本不在秘书目录里**。
- **保留的只读面**：`tool-fs`(read) / `tool-fs-search` / `tool-web`（搜索、抓取）/ `tool-ask-user` / `tool-todo` / `present` / `skill`，创造模式再加 `cordis_inspect_*`。秘书仍然能读代码、查运行时状态、核对报告，但不能执行。
- **主 Agent 只是秘书**：只做对接用户、澄清目标、写任务书、交给领导、只读验收、汇报。工程动作只剩三个 `delegate_leader*` 出口。
- **领导多入口**：秘书按任务选 Claude Code（质量/前端）、Astra（后端疑难）或 DeepSeek Flash（预算紧、任务明确）。三个入口共用同一领导预设与工具面，只有模型路由不同。
- **团队编制齐全**：领导之下常备 fast（快/便宜）、stable（稳）、writing（写作）、backend（后端疑难）、frontend（前端/视觉，真实 Claude Code）五类成员，覆盖标准团队该有的角色；需要更专门的 agent 时，领导用 `agent_preset` 把专用预设成员加进来（临时增编）。
- **成员可换预设**：`delegate_worker_*` 接受可选 `agent_preset`；可选集合在运行时从 `agentPresets.list()` 动态读取（排除 `secretary-*` 与 `team-leader*`，跳过加载失败的预设，最多 15 个）。
- **保持扁平**：成员换预设只换工具与专长；`agents.isOwnedBy` 识别领导名下的成员后，在成员自己的 scope 用 `tools.restrict()` 屏蔽 `subagent` / `spawn_teammate` / `send_message` / 团队任务工具。
- **扩展线不变**：`workbenchMemberRoutes` 仍可在运行时覆盖成员模型；旧 Workbench 的源码补丁工具（pin 2.0.0 指纹）不再需要，遇到新版本会安全拒绝而不是乱改源码。

## v2.1 升级：主 Agent 只是秘书，领导带团队干活

## v2.0 升级：Claude 必须经真实 Claude Code

```text
用户 ↔ 秘书（DS，可处理简单事）
          ├─ delegate_leader → Claude Code CLI（xindupx / Opus）
          │                      ├─ 亲自读写、调试、整合
          │                      └─ 独立 MCP → DS / GPT / Gemini / Claude Code 成员
          └─ delegate_leader_astra → DSH 原生 GPT 工程领导
普通会话：delegate_claude_code → 同一真实 CLI 领导
```

- `delegate_worker_frontend` 和 MCP `frontend` 都绑定 `secretary-cc-worker`，不会原生 spawn Claude；CC成员没有成员MCP，不能继续分派。
- Claude CLI固定本机2.1.198及SHA-256；每次启动复核。沿用xindupx与凭据引用，凭据仅注入子进程环境；不输出、不进argv或MCP配置正文。
- `agent/request` + `llm/stream` 拒绝可识别的原生Claude请求（含旧子会话续跑），不会静默fallback。普通会话需用明确的CLI入口，不能直接在模型选择器选Claude后仍当原生Agent运行。这是受控DSH调用链的策略，不是对任意Host插件、同用户进程、shell直连网络的OS安全保证。
- 每个CLI run拥有独立loopback capability；MCP仅提供dispatch/status/wait/cancel，不能指定任意provider/model/preset/owner/cwd/URL；最多4个并发、12次派发、10分钟、每次CC $2 API预算（不等于所有下属总费用）。跨run访问、同键改任务、并发文件范围重叠均拒绝。清理失败会使run失败并停止再派发。
- CLI自身是external leaf，DSH成员的真实parent是获授权的秘书/主会话。journal记录CLI run与成员逻辑关系，不能伪造一个DSH Agent父节点来美化GUI子树。
- 仅接受父会话已处于`danger-full-access`的CLI任务；`read-only`/`workspace-write`会失败关闭，不越过沙箱。文件范围是协作约束，不是OS隔离。
- CC执行仍为单次任务，无`send_message`续接；返工需重新交完整任务书和前次证据。Codex CLI尚未接入本成员桥。

### 官方兼容核验

DSH官方0.2.1-rc.3 Claude Code插件使用官方Agent SDK 0.3.263及真实CLI，但没有per-run MCP、credentialRef、宿主CLI固定或续接接口；不能直接替换后宣称团队已接通。本升级采用同一DSH subagent公共契约，为既有固定CLI增加run-owned MCP桥。

DeepSeek的[Claude Code集成指南](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)及[Anthropic兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)讲的是**Claude Code运行DeepSeek模型**，不是DSH团队插件；模型名映射不代表真实Claude模型。本升级的Claude仍走xindupx，没有偷偷换成DeepSeek模型。

### 本轮验证与部署状态（2026-11-02）

- 隔离回归：旧6组加CLI路由/策略、broker、transport、provider、process及CLI证据复核，共13组；实际Host的Schema另行离线核对14条工具配置。离线真实Cordis/官方tool-subagent集成还复现旧standing安装路径的兄弟fiber残留，并确认当前direct-Agent wrapper卸载会撤掉真实工具；缺Session时拒绝退回旧安装路径。
- 真实CC无密钥协议测试：本地Anthropic模拟接口→真实CC→MCP→本地成员替身已完成；验证env变量展开与MCP工具往返，不算线上模型测试。Windows测试目录在同一tool job内删除出现锁定，现分离协议和清理两步，两个阶段都成功才算完成清理。
- 线上第一次：run `31a353bb-cc48-4537-a8b7-2c1accd3cf19`，真实CC亲自写leader文件，经MCP派DS成员`3d08ce20-7a9e-4622-a219-46adf9d18724`写worker文件，终态completed；Lead独立Node严格断言通过。详见[CLI元数据日志](<../../research/secretary-team-20261030/cli-runs.jsonl>)。
- **整体部署尚不能宣称完成**：`plugin_manager install_bundle`返回already-installed；对已选bundle做幂等enable触发reconcile后，返回`application: restart-required`、`restartReason: unmanaged-plugin`。新CLI provider/通用工具已可用并通过上述实测，但旧会话的原生委派fiber不能据此认定已全部迁移。未自动重启Host，需用户方便时重启后核对新秘书链路。
- 线上第二次：run `81814b6a-fd6a-495a-8a40-9ee68766f10a` 派出CC成员 `ebe5895f-c8ef-481a-8ce9-c5de783ea245`，其自身CLI Write成功创建frontend文件；GPT/backend成员 `2c19fd05-cdbf-4fd3-bee4-0818923982e0`、`0e2484d8-74b6-4633-80d3-28fbff430307` 均失败。第一份GPT会话终态为`TRANSPORT: Stream ended without finish_reason`，没有创建backend文件，混合团队验收不能标PASS。领导CLI completed仅表示会话结束，不等于交付全部成功。
- CLI报告费用：第一次领导约$0.307；第二次领导约$1.738、CC成员约$0.066。这是CLI返回的估计值，不含DS/GPT渠道实际账单。
- 原生树的[验收脚本](<scripts/verify-acceptance.cjs>)不适用于external CLI树；不能把旧16/16或合成场景当CLI验收。
- 新增只读[CLI运行复核](<scripts/verify-cli-run.mjs>)：按精确runId关联每个CC进程与成员；原生成员另读DSH session核对parent、preset、路由与终态。日志缺失返回INSUFFICIENT，成员失败不会被领导completed或后续reload洗白。历史运行A复算PASS，B复算FAIL；它仍不代替交付文件/测试的独立核验。

### 运行与回退

```powershell
node test/run.mjs
node scripts/self-test-acceptance.mjs
# 只读复算已发生的CLI运行，不发起模型请求：
node scripts/verify-cli-run.mjs 31a353bb-cc48-4537-a8b7-2c1accd3cf19 --require-workers --require-leader-write --expect-routes=fast
# 无密钥真实CLI测试（独立进程，不动Host）：
pwsh -File scripts/smoke-cc-mcp-local.ps1
# 上一条结束后，使用其cleanupDir做第二步清理：
pwsh -File scripts/smoke-cc-mcp-local.ps1 -CleanupDir '<输出的临时目录>'
```

源码基线为`87b64cc`；需回退时只回退本bundle目录并用插件管理器应用，不手写profile、不自动重启、不移除其他插件。回退会重新允许原生Claude，与当前硬要求冲突，必须先告知用户。当前新代码不是OS权限屏障；不以隐藏模型名代替真实CLI执行证据。

---

## 以下为 v1 历史实现与迁移记录（不是 v2 当前说明）

**秘书对接用户，工程主 Agent（领导）负责实现并指挥下属子 Agent。** 一个 bundle，六个预设。

> 2026-11-02 用户纠正：领导可以直接写文件、调试和执行，不是只派活的经理。下文当前规则已经修正；历史版本与旧验收记录仅作溯源。Claude Code / Codex CLI 也可以承担领导角色，但当前路由仍是 DSH 原生模型 Agent，尚未接成 CLI 领导。

```text
用户 ⇄ 秘书（对接、简单事、目标与授权、结果核验）
          │ delegate_leader / delegate_leader_astra
          ▼
        工程主 Agent / 领导（可亲自实现、写文件、调试、整合）
          │ delegate_worker_fast / _stable / _writing / _backend / _frontend
          ▼
        团队成员（DS / GPT-6.1 Sol / Gemini / GPT Astra / Opus）
```

当前实现走 DSH 原生子代理链路：领导在会话树上是秘书的子会话，在工程职责上是主 Agent；成员是它的子 Agent。职责与会话树层级不要混为一谈。

CLI 领导目标：秘书 → Claude Code（CC）或 Codex CLI → DS/GPT 成员。要复用 DSH 的异构成员，需要任务级 MCP 委派桥；直接启动 CLI 一次不等于已经接通团队。现有 CC provider 是 one-shot、`--no-session-persistence` + `--strict-mcp-config`；没有传入成员 MCP 配置，不能继承 DSH preset 工具。现有 Codex bridge 是 Codex→DSH 科研工具，不是 DSH→Codex 启动器或通用成员委派桥。本轮只读核对，不更改全局渠道或 CLI 配置。

## 预设

| id | 显示名 | 用途 |
|---|---|---|
| `secretary-standard` | 秘书·标准模式 | **用户选这个**。对接、办小事、验收、派活给领导 |
| `secretary-cordis` | 秘书·创造模式 | 同上，加插件/Cordis 开发能力 |
| `team-leader` | 团队领导（标准） | 秘书派活时自动使用 |
| `team-leader-cordis` | 团队领导（创造） | 创造模式下自动使用 |
| `team-worker` | 团队成员（标准） | 领导派活时自动使用 |
| `team-worker-cordis` | 团队成员（创造） | 创造模式下自动使用 |

后四个是 `agentPreset` 目标，一般不用手动选。

## 模型与预设分工（模型路由写死在工具里；成员预设运行时可选）

| 工具 | 路由 | 适合 |
|---|---|---|
| `delegate_leader` | `xindupx/claude-opus-5-5` (high) | 编排、前端与审美、整体设计 |
| `delegate_leader_astra` | `banology-gemini/gpt-6-astra` | 后端、架构、疑难推理 |
| `delegate_leader_deepseek` | `deepseek-account/deepseek-flash` | 预算紧、任务明确：小改造、执行型领导 |
| `delegate_worker_fast` | `deepseek-account/deepseek-flash` (low) | 快、便宜：检索、批量改写、跑命令 |
| `delegate_worker_stable` | `moeblack/gpt-6.1-sol` | 稳、质量好：关键实现 |
| `delegate_worker_writing` | `banology-gemini/gemini-4-argon` | 中文写作、润色、文案 |
| `delegate_worker_backend` | `banology-gemini/gpt-6-astra` | 后端、疑难 bug |
| `delegate_worker_frontend` | `xindupx/claude-opus-5-5` (high) | 前端、交互、视觉 |

成员工具额外接受 `agent_preset`，可选集合来自运行时预设注册表（排除 `secretary-*` / `team-leader*` / 加载失败项，最多 15 个）；不传则用上面的默认 `team-worker(-cordis)`。

**Opus 为什么走 xindupx**：本机会话记录里，`banology/claude-opus-5-5` 作为子代理共成功 42 次、失败 12 次，最后一次成功是 2026-10-21；此后 12 次子代理调用全部 0 token 失败，12 份会话日志里都有中转返回的 `503 No available accounts`。2026-11-01 20:25 做了线上实测：banology 的 `GET /v1/models` 返回 200 但只有 7 个模型（gpt-image / gpt-6 / gemini），**一个 claude id 都没有**；`POST /v1/messages` 直接回 503 `{"error":{"code":"model_not_found","message":"No available channel for model claude-opus-5-5 under group vip (distributor)"}}`。也就是说这个中转已经不再供应 Claude，不是临时掉线。同时间 `xindupx/claude-opus-5-5` 实测 200 出字（`ok`，22 tokens），它的 `/v1/models` 列出 14 个 claude 型号。实测脚本：`tmp/agent-team-diagnose-20261030/probe-banology-claude.mjs`、`probe-xindupx-opus.mjs`；统计脚本（只读）：`opus-route-recount.cjs`。banology 恢复 Claude 后可以把 `preset/delegation.mjs` 里的 `OPUS` 常量改回去。

约束分三层：

1. 工具里写死 `agentOptions` 与 `agentPreset`，领导和秘书都改不了路由。
2. 两个领导预设的 `tool-fs` 配置为 `write: true, edit: true`，可以亲自实现，也可用固定路由分派成员；不挂秘书专属写入闸门。
3. 人设要求领导对工程结果负责；领导自己与成员不能并发修改同一文件，交接后重新读取。直接编码或执行写入命令不构成角色违规，仍须遵守任务授权范围。

## 2026-11-02 角色纠正与验证范围

- 两个领导预设恢复 write/edit，移除“管理者不动手”指令；增加领导与成员并发文件交接规则。秘书及全局 Claude 开关未改。
- 新增 `test/leader-role.test.mjs`，先对旧配置观测到12项失败，再修正配置通过；现共6组测试。合成验收15个场景通过，含领导独立实现与领导+成员，不依赖真实委派日志。
- 用旧真实会话 `session-2daf5f82-f43e-47a7-97d7-a226b481dffc` 重核：仍失败于“领导没有 write/edit”和“该树历史挂载错误”。不把旧通过输出冒充新语义验收。
- 用户于本地 01:34:53 重启了 Host；重启时两个领导 YAML 已改，激活日志为 `2026-11-01T17:35:31.946Z`（本地 01:35:31）。运行时代码标记仍为1.7.3，本轮不改委派模块；manifest原为1.7.2，本次角色补丁用Git提交标识。声明在册不等于新领导已经实际写过文件。
- CLI 领导方案详见仓库根目录 `docs/superpowers/specs/2026-11-02-cli-engineering-leader-design.md`。当前仅做接入调查与方案，未安装 CLI worker broker、未真实跑 CC/Codex→DS/GPT 团队。

## 安装 / 卸载

```text
plugin_manager install_bundle  target = <你的工作区>\projects\dsh-secretary-team
plugin_manager remove_bundle   target = @local/dsh-secretary-team
```

**怎么让改动生效（2026-11-01 实测更正）**：只改 bundle 里的 `.mjs` 不会触发重新 `apply`，日志里也不会出现新的 `bundle x.y.z` 行——但**不需要重启桌面端**：profile 配置文件（`profiles/desktop/cordis.patch.yml`）一有变化，DSH 的 HMR 就会跑一次 `recomposeProfile`，把所有 entry 用磁盘上的新代码重新 apply。20:34 就是这样把 v1.4 装上线的：日志出现 `delegation plugin active (bundle 1.4.0, …)`，紧接着 `tools/change` 协调给当时还活着的那个 `secretary-standard` 会话补挂上了两个领导工具。已存在的会话保留它启动时的预设版本，验收仍建议开新会话。

改动 profile 补丁前先备份成 `cordis.patch.yml.bak-<日期>-<原因>`（历史备份都在同目录）。

### 依赖的 profile 行

委派工具的路由写死在 `agentOptions` 里、不开放模型选择，所以 `subagent-model-selection-settings` 的白名单不拦它们（官方实现只在工具开放了模型选择时才查白名单）；起子代理前只做路由预检，要求 provider 和 model 在 profile 里注册过。`xindupx/claude-opus-5-5`、`moeblack/gpt-6-astra` 都已注册，也都在白名单里。

## 验收（由用户在 GUI 里手动发起）

1. 新会话选「秘书·标准模式」，模型选 deepseek-flash。
2. 给一个复杂任务（要改两个以上文件）。预期：秘书不自己动手，调用 `delegate_leader`。
3. 看子代理列表：原生领导 1 个（Opus 5.5 / xindupx），按任务需要选择成员；不要求所有任务都派成员。
4. 领导可直接写文件、调试、整合；成员可实现或审查独立部分。专门验证三层协作时明确要求至少一名成员并使用 `--require-workers`。要取证领导直接写入，使用 `--require-leader-write`，并额外核实 tool result 和交付物。
5. 秘书自己读文件、跑命令验收，再向用户汇报。
6. 给一个十分钟内的小任务。预期：秘书直接做完，不派活。

### 现成的验收用例

复杂活（应转交）：

```text
在 <你的工作区>/tmp/secretary-team-smoke/ 下新建一个 node 项目：
1. src/sum.cjs 实现 sum(a,b)，src/fmt.cjs 把结果格式化成 "sum=3"；
2. test/run.cjs 用 node:test 覆盖 sum 与 fmt；
3. package.json 加 npm test 脚本；
4. 跑通 npm test 并把输出贴给我。
```

简单活（应自己做）：

```text
看一眼 <你的工作区>/projects/dsh-secretary-team/package.json，
告诉我这个 bundle 的包名和版本。
```

## 边界插件

两个秘书预设都挂了一行 `boundary`（`preset/boundary.mjs`）。它做两件事：

1. 在 `system-prompt/assemble` 里把 Team 工具（`spawn_teammate`、`send_message`、`team_task_*` 等）从模型看到的工具表里滤掉——因为 Agent Teams 那一层会把它们注入每个 scope，而 `tools.restrict()` 对 scoped 工具故意不生效。
2. 用 `tools.guard()` 兜底：万一模型凭记忆点名调用，直接拒绝并提示改用 `delegate_leader`。

端到端第 1 次的会话记录证实：秘书收到的 34 个工具里 Team 工具 0 个，委派工具正好是 `delegate_leader`、`delegate_leader_astra`。

## 委派工具怎么装（v1.2 起的结构，重要）

预设作用域里声明 `tool-subagent` 行**不会注册工具**。原因在官方实现：一行 `tool-subagent` 同时带 `agentPreset` 又在预设作用域里时，它放弃全局安装、改走"逐 Agent 安装"，触发点是 `agent/created` / `tools/change`；而 `agentPresets.mount()` 的顺序是先 `mount`（plugin apply）再 `bind`（把 Agent 的 scope 父亲接到预设组合 scope），apply 时 `belongsToComposition()` 还是假，这条路径就永远不触发。

Host 级声明式行也不行：`tool-subagent` 在激活时校验 `agentPreset`，而预设注册表是异步登记的，行先跑就报 `Unknown agent preset: team-leader`。

全局注册能装上，但 7 个委派工具会出现在所有会话里，只能靠 guard 拦——不算隔离。

**解法：按 Agent 的作用域注册。**

| 层 | 内容 | 文件 |
|---|---|---|
| 预设层 | 6 个预设（秘书/领导/成员 × 标准/创造），不含委派行 | `cordis.patch.yml` |
| Host 层 | `preset/delegation.mjs` 监听 `agent/created`，取到该 Agent 的预设 id，判断它该有哪些工具，再把官方 `tool-subagent` 挂到**这个 Agent 自己的 `agent.ctx`** 上 | `cordis.host.yml` |
| 预设内 | `preset/boundary.mjs` 挂在两个秘书预设，把 Agent Teams 注入的 9 个 Team 工具从工具表摘掉 | `cordis.patch.yml` |

挂到 `agent.ctx` 后 `compositionScope` 就是该 Agent 自己，`belongsToComposition()` 恒为真，官方的逐 Agent 安装路径于是正常触发。

`delegation-status.log`（`research/secretary-team-20261030/`）每挂一个 Agent 记一行，v1.3 起每个工具后面带上实际路由，例如 `delegate_leader(xindupx/claude-opus-5-5)`；Host 加载模块时还会记一行 `delegation plugin active (bundle 1.4.0, …)`，用来确认 Host 跑的是哪个版本。

**v1.4：会话中途切预设也要挂上。** 只在 `agent/created` 里挂会漏掉一种常见操作：先在默认预设下开好会话，再在 GUI 里把预设切成「秘书·标准模式」，然后才发第一条消息。这时 `agent/created` 拿到的还是旧预设（`standard`，0 个委派工具），之后不会再触发；端到端第 3 次就是这么挂了空。v1.4 同时监听 `tools/change`（`agentPresets.recompose` 重新绑定后由注册表发出），对每个活着的 Agent 重算一遍工具集：集合没变就什么都不做，变了就先 `dispose()` 旧挂载再挂新的。挂载点的 key 是解析后的工具名列表，所以挂工具引发的 `tools/change` 第二次进来就直接返回，不会重复挂。

## 验证记录

**v1.2 静态与工具表验证（2026-11-01）**：预设名册 12 个，本包 6 个全部在册、激活诊断 0 条；26 个被引用的插件包在 0.2.1-rc.3 中全部存在。工具表：`secretary-standard` 有且只有 2 个领导工具，`team-leader` 有 5 个成员工具，其它会话 0 个。

**端到端第 1 次（2026-11-01 05:26，v1.2）**：

- 秘书（ds-flash）→ 领导：正常转交，任务书完整。
- Opus 领导（banology）：503 `No available accounts`，0 token 失败；秘书自动改派 Astra 领导。
- Astra 领导：工具表里有 5 个 `delegate_worker_*`，但它自己用 `pwsh` 和 `write` 写完了 `report.md`，没有派成员。
- 秘书核对文件后向用户汇报，`report.md` 内容正确。

v1.3 针对这两处修复：Opus 改走 xindupx；领导去掉 `write` / `edit`。

**v1.3 离线验证（2026-11-01，未重启 Host）**：在独立进程里加载 `delegation.mjs` 的副本，日志改写到临时文件，官方 `tool-subagent` 换成只记录配置的桩。8 个预设的挂载结果符合预期：两个秘书预设各 2 个领导工具，两个领导预设各 5 个成员工具，成员预设和官方 `standard` / `cordis` 都是 0 个；`delegate_leader` 与 `delegate_worker_frontend` 都是 `xindupx/claude-opus-5-5@high`。14 份工具配置都通过已安装 `dsh-tool-subagent` 的 `Config` 校验；领导的 `tool-fs` 配置经官方 schema 解析为 `write=false edit=false read=true`。真实 `delegation-status.log` 的行数前后不变。脚本：`tmp/agent-team-diagnose-20261030/offline-delegation-test.mjs`。

**端到端第 2 次（v1.3，2026-11-01 18:58）——失败，暴露一个真 bug**：秘书会话在默认预设下创建（`preset=standard`），7 秒后用户在 GUI 把预设切成 `secretary-standard`，然后才发第一条消息。会话日志里 `agent-preset/selected` 记的是 `secretary-standard`，但 `delegation-status.log` 在 10:58:16 记的是 `preset=standard tools=0`——插件是在创建那一刻判定的，之后没有任何信号让它重算。结果秘书手里 32 个工具、没有 `delegate_leader`，它自己用 `write`/`edit` 把 4 个文件写完了，并在汇报里明确说"本会话里没有 delegate_leader 工具"。这不是提示词问题，是挂载时机问题。

v1.4 修掉它：额外监听 `tools/change`，按预设重算并替换挂载。离线用例覆盖了「默认预设创建 → 切秘书 → 切领导 → 切成员」四种状态：切到秘书后挂上 2 个领导工具；重复 `tools/change` 0 次多余挂载；切到领导后旧的 2 个被 dispose、挂上 5 个成员工具；切到成员后全部卸掉。脚本：`tmp/agent-team-diagnose-20261030/offline-delegation-v14-test.mjs`。

**热重载到底怎么工作（2026-11-01 直接读实装源码核对，不是猜的）**：

- `@deepseek-ai/dsh-hmr` 只监听两个文件：`profile/cordis.patch.yml` 和 `home/cordis.patch.yml`。它把这两个文件的内容加上 manifest 里的 `dsh.profile.bundles` 列表拼成 inputs，和上次比较，变了才跑 `reconcileProfile()`。
- 每次 reconcile 时，`@deepseek-ai/dsh-app-boot` 的 `readProfilePatches()` 会**重新读完整补丁栈**：所有 bundle 的 patch 文件 + profile 补丁 + home 补丁 + overlays。
- 结论：改 bundle 里的 `.mjs` 或 `cordis.patch.yml`（预设行、插件行）**都不会自己触发**重载，但**下一次**重载会把它们读进去——模块在"加载模块与磁盘比较"阶段重新 import，预设行在补丁栈重组时生效。所以"碰一下 profile 补丁"这一下可以同时上线模块与预设行的改动（v1.5、v1.6 都是这么上线的，Host 没有重启、没有崩溃）。
- 只有 HMR 自己报 `restart required` / `changed modules keep running their previous code until a restart` 时才需要重启桌面端。

**端到端第 3 次（v1.6+）**：用户在 GUI 手动发起；先选预设再发消息、以及先开会话再切预设，两种路径都应该挂上。跑完只读核对，**不需要会话 id**（默认自动挑最近一次 `secretary-*` 会话，可加 `--since=<ISO>` 或显式 id）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& '<DeepSeek Harness 安装目录>\DeepSeek Harness.exe' `
  '<你的工作区>\projects\dsh-secretary-team\scripts\verify-acceptance.cjs'
```

当前验收要求领导被提供 write/edit、job_output 和成员委派工具，不禁止领导直接写文件。默认允许领导独立完成，成员相关检查无适用对象时记 N/A；`--require-workers` 强制验证三层协作，`--require-leader-write` 检查直接 write/edit 调用证据。`--project=<目录>` 只列文件，不证明内容正确；该脚本统计工具调用，不替代 tool result 核对与交付物独立测试，也不适用于 CLI 外部领导的完整链路。

委派错误按被验会话树归属，不能被之后的 reload 清零；缺日志返回 INSUFFICIENT。`--delegation-log=<路径>` 用于隔离测试。自测覆盖领导单独实现、领导+成员、恢复只读的回归、错误 Claude 路由、旁路工具、reload 后旧失败仍保留，以及日志缺失。离线测试通过不等于新领导会话的 live 验收通过。

## 历史验收：旧只读领导规则（2026-11-02 01:20）

**证据更正（2026-11-02）**：当时脚本输出 `RESULT: PASS` 16/16，但检查的是旧“领导不写文件”规则；而且把后续 reload 之前的 mount 失败排除了。因此不能把那个输出称为无缺陷的整体验收，更不能证明工程主 Agent 或 CLI 领导新要求已经通过。真实三层委派和交付物测试的记录仍保留；当前脚本会保留该树的历史挂载失败。

真实运行：用户 2026-11-02 00:50（本地）在 GUI 新建会话「秘书·标准模式」发验收任务，原生三层链跑通。

| 层 | Agent | 预设 | 路由 | 结果 |
|---|---|---|---|---|
| 秘书 | `session-2daf5f82` | `secretary-standard` | `deepseek-account/deepseek-flash@high` | 20 次工具调用，`delegate=[delegate_leader]`，write/edit=0，自己重跑验收 |
| 领导 | `dace3d25` | `team-leader` | `xindupx/claude-opus-5-5@high` | 11 次调用，派了 `delegate_worker_stable`，write/edit=0（目录里没有 write/edit 工具），只跑只读命令 |
| 成员 | `7135f756` | `team-worker` | `moeblack/gpt-6.1-sol` | 16 次调用，`write` ×4 落了 cli.js / scores.json / README.md / test.js |

16 项断言全 PASS（含"领导没被提供 write/edit"、"领导/成员没被提供 subagent\*/Team 工具"、"秘书没被提供 subagent\*"、"领导被提供 job_output"）。交付物我独立复跑过：

```
node cli.js  → 7 行按分数降序（含同分按姓名升序），exit 0
node test.js → ok 7/7，exit 0
目录只有 4 个文件，无子目录
```

期间发现并修掉的两处：

- 委派日志里 10 条 `mount ... failed ... cannot create effect on inactive context`：领导跑完后 scope 已释放，而一次 `tools/change` 又触发 reconcile，误当成挂载缺陷。v1.7.3 把它识别成 teardown（记一条 `inactive: context unloaded`，不再报失败、不再重试）。
- 验收脚本把领导命令里的 `'>>> node cli.js'`（引号里的 echo 标记）当成文件重定向，误报"领导在写文件"。改成先剥掉引号段再判重定向，并用正例/反例双向自测确认没有放宽。

## v1.7.3 变更（2026-11-02 01:14）

- `preset/delegation.mjs`：reconcile 撞上已卸载的 Agent context 时按 teardown 处理——停止挂载、清掉已挂的 fiber、surface 记 `inactive:<key>`（不再反复重试），日志写 `inactive: context unloaded, nothing mounted` 而不是 `mount ... failed`。`test/delegation.test.mjs` 加 3 条断言（无 failure 行 / 有 inactive 行 / 没有残留挂载）。
- `scripts/verify-acceptance.cjs`：写入型 shell 的判定先剥引号段；"无 mount 失败"这条断言改为只统计**当前 bundle 版本激活之后**的日志（旧版本留下的失败行不该算在这次运行头上），标签同步改成 `... since the live bundle loaded`。

## v1.7.2 变更（2026-11-01 23:11）

**线上对照实验**：22:33 用户在秘书会话里发验收任务，模型原文是「这个任务由我自己来办：共 4 个小文件，十来分钟能收工，派团队反而绕路」，然后 `write` ×4 把项目写完了。事后查该会话的 system prompt，秘书人设确实在（9619 字符、含「你是这个会话的**秘书**」），所以问题不是人设没挂上，而是**纯提示词约束不住 deepseek-flash**。

两层修：

1. **人设改成可计数的硬规则**（`secretary-standard` / `secretary-cordis` 两处）：动手前先数文件——**新建 ≥ 1 个或改动 ≥ 2 个 → 必须派活**；明确列出不允许的推翻理由（"我自己做更快""文件都很小""派团队反而绕路"），并把 22:33 那次写成真实反例；要求每轮正文第一行先写「判断：新建 N 个 / 改动 M 个文件 → 派活 / 自办」，写了"派活"就必须紧接着真调 `delegate_leader`。
2. **机械闸门 `preset/secretary-gate.mjs`**（只挂这两个秘书预设）：`tools.guard` 拒绝 `write`（新建或整体重写文件）和写文件的 shell（`Set-Content` / `Add-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Remove-Item` / `mkdir` / `rm` / 重定向），拒绝信息点名 `delegate_leader`；`edit` 与只读命令照常放行——"改一个已存在的文件"才是秘书的简单活。领导/成员预设**不**挂这个闸门（成员必须能写文件）。
3. 新增 `test/gate.test.mjs`（22 条：write 被拒、edit/read/只读 shell 放行、`2>&1` 不误伤、拒绝信息点名 delegate_leader 等），bundle 测试 **5/5**。

生效边界：改的是 bundle 补丁 + 新模块，靠 profile 补丁里的一次 reload trigger 触发重载；`delegation-status.log` 里 `2026-11-01T15:11:54.055Z … (bundle 1.7.2 …)` 之后**新建**的会话才带新规则。

## v1.7 变更

**线上发现（不是审计猜的）**：21:41 那个 `secretary-standard` 会话的工具表里仍有 `subagent_claude_code`，而 `system-prompt/assemble` 过滤已经把它摘掉了 —— 说明"prompt 装配时过滤"够不到这一条。原因：`tools.view(scope).visible`（请求头里的 tools 就是它）与装配钩子不是同一条路径，而 Claude Code CLI provider 的 `tool-subagent` 行是在**启动后**（版本探测结束）才注册进全局的，装配过滤对它生效不了。

- `preset/boundary.mjs` 增加 `tools.restrict({ deny: [name] })`：把 Team 工具和 `subagent` / `subagent_fork` / `subagent_claude_code` 作为**全局工具**在本 Agent scope 里掩掉。这是官方语义（`dsh-tools` 的注释：restrict 掩全局工具、作用域内注册不受影响、多条限制取交集），所以固定路由的 `delegate_*` 不受影响。
- `restrict()` 对"这个 scope 里不是全局工具的名字"会抛错，所以逐个 try/catch：抛了就说明这条不是全局工具（守卫仍然拦调用），并在 `tools/change` 时重试 —— 晚注册的 `subagent_claude_code` 会在下一次工具变化时被掩掉。
- 保留原有的 `tools.guard`（执行层拒绝）和装配过滤（prompt 层），三层叠加。
- 离线用例从 43 条加到 47 条：断言 restrict 掩掉的集合、`tools/change` 重试注册、以及"名字还不是全局工具时不从 apply 抛出去、之后靠 tools/change 补上"。

**部署与生效边界**：Agent 是**一次性组合**的，21:41 那个会话（v1.6 时代创建）不会因为重载而拿到新目录；验收必须用 v1.7 上线（22:02:23Z 的 `bundle 1.7.0` 激活）之后**新建**的会话。

**v1.7 的 restrict 被真实数据否掉了，最终用行禁用兜底（2026-11-01 22:52）**：22:46 由用户新建的会话（v1.7 之后创建）其 `request/header` 里**仍然**有 `subagent_claude_code`，说明 `tools.restrict()` 对这条全局工具没生效（大概率是 `tool-subagent` 的注册落在 scope-local 层，restrict 命不中；未最终确认）。兜底做法是在 profile 补丁里把 host 级行 `tool-subagent-claude-cli` 置 `disabled: true`：

- 实测证据：禁用前最后一次请求（14:46:26Z）仍带该工具，禁用后 14:52:46Z / 14:53:06Z / 14:54:20Z 的三次请求 header 全部 `subagent_claude_code=false`。
- 代价：**所有** Agent（含主会话）失去 Claude Code 外包通道；要恢复就删掉那行 `disabled: true`（备份 `cordis.patch.yml.bak-20261101-disable-claude-tool`）。
- `boundary.mjs` 里的 restrict + guard + 装配过滤保留作第二、三层防线，但验收以真实 header 为准。

## v1.6 变更

一轮外派审计（Claude Code，只读）找到 11 条，逐条核对后改了下面这些：

- **创造模式链路根本没接上（高）**：工具表原先写死 `agentPreset: 'team-leader'` / `'team-worker'`，`secretary-cordis` 派出来的活会落到**标准**领导，而只有 `team-leader-cordis` 才有 `tool-cordis`、skills 和"团队不装插件"的规矩。现在按预设分表：`secretary-cordis → team-leader-cordis → team-worker-cordis`，`allowedAgentPresets` 也收窄成单一目标。
- **领导派了活收不回来（高）**：领导预设里没有 `tool-jobs`，但成员工具默认允许 `run_in_background`；领导按人设"并行派发"拿到 job id 后既没有 `job_output` 也收不到完成通知。两个领导预设都补上 `tool-jobs` 行。
- **领导和成员能绕过整支队伍（高）**：`subagent_claude_code` 是全局工具（acceptEdits + Write/Edit/Bash，深度不受限），而 boundary 只挂在两个秘书预设上。现在 boundary 挂全部 6 个团队预设，把 Team 工具与 `subagent` / `subagent_fork` / `subagent_claude_code` 一并摘掉并加 guard；真需要一个 Claude Code 成员的话应该加一条固定路由工具，而不是把全局工具放回来。
- **挂载失败被当成成功（中）**：原先先写 key 再挂，失败只记日志，下一次协调看到 key 一样就直接返回，会话整局少一个工具。现在失败会清理半成品 fiber、把 key 记成 `undefined` 逼下次重试，日志写实际挂上的数量 `[2/2]`。
- **模块加载失败被永久缓存（中）**：`modulePromise` 拒绝后不再重置，一次瞬时失败会让所有委派工具直到下次重载都起不来。现在拒绝时清空缓存。
- **协调中途来的预设切换被丢掉（中）**：`reconciling` 命中时直接 return，快速切预设会留下过期工具表。现在排队（`pending`）并在 `finally` 里重放。
- **无工具预设每次都刷日志**：改成记 `{key:'none'}`，重复 `tools/change` 不再重复打印。
- 顺手改掉 bundle 头部关于 `allowedModels` 的过期注释（固定路由并不受它限制），并给 `boundary` 补上 `followup_task`（上游新版本的 Team 工具，现在这版 Host 还没有）。
- **bundle 自带离线回归**：`node test/run.mjs`（4 个文件、119 条断言：预设生命周期、热重载、四条固定路由与重试路径、boundary）。用例只在临时目录里造桩，跑完自查真实日志行数未变；不需要 Host，也不会碰它。
- **人设跟工具对齐**（同版热重载上线）：两个秘书人设改成"派活只有 `delegate_leader` / `delegate_leader_astra` 一条路，Team 工具与 `subagent*` 已由预设屏蔽、硬调会被拒"；两个领导人设补上"派发默认等成员返回，用了 `run_in_background` 就用 `job_output` 取结果再继续"，标准领导还加了一条"你只有 `delegate_worker_*` 这一条派活路径"。人设改动只影响**新建**的 Agent，已在跑的会话不受影响。

审计里其余几条的处理：`subagent_claude_code` 对秘书的旁路 v1.5 已挡、这版扩到全队；`followup_task` 已补；`7342f4bd` 那个会话建议别复用（新旧两套挂载的残留状态不可考）；"重复工具"那条断言无效，已从验收脚本换成扫日志。

## v1.5 变更

- `preset/delegation.mjs`：挂载记录从模块级 `WeakMap` 改为写在 Agent 自身上的 symbol 属性（`Symbol.for('@local/dsh-secretary-team/surface')`），Agent 不可扩展时退回 WeakMap。热重载会让模块状态清零，而旧挂载可能还挂在 Agent 上，模块内状态记不住它们。
- 重写后的协调逻辑会把上一版留下的挂载视为自己的：重载后不会重复挂同一套工具，切预设时会把上一版留下的那几个一起 `dispose()`。
- `preset/boundary.mjs`：除了 9 个 Team 工具，还把 `subagent`、`subagent_fork`、`subagent_claude_code` 从秘书的工具表里摘掉并加 guard。起因是 2026-11-01 20:34 Claude Code 子代理通道上线后，它的行是全局的，秘书因此多出一条"直接开外部子代理、绕过领导"的路。

**关于"热重载重复挂载"的证据强度**（审计纠过一次）：`offline-delegation-reload-test.mjs` 用桩 fiber 模拟重载，v1.4 判出 4 个挂载、切走后剩 2 个，但桩不检查重名，而真实 registry 会拒绝同一作用域里的重名注册（`tools.register` 重复即抛）。真机上 12:37 那次重载后 12:38 的挂载是**干净的重挂**、日志里没有任何失败行——说明 Cordis 换 entry 时把旧挂载一起 dispose 了。所以 v1.5/v1.6 的"记在 Agent 上"是加固而非救命：它的价值在真实故障路径（旧 fiber 存活但模块状态丢失）上。这一点之前写成了"实测 4 个挂载"，是过度解读，已改正。

**事故记录**：取证用的诊断插件 `tmp/preset-probe7` 在收集结果时把 Agent 对象传给了 `ctx.subagents.listDescendants()`（它要 session id 字符串），触发 `SessionQueryError: session "[object Object]" not found`，Host 因 fatal load failure 两次退出（05:28、14:50）。插件已卸载，`node_modules/@local` 下 7 个残留链接已删。之后不在用户正在使用的 Host 里装自动化探针：验收由用户在 GUI 手动发起，代理只读会话日志核对。

## v1.4 变更

- `preset/delegation.mjs` 增加 `tools/change` 协调：会话中途切预设也能挂上正确的委派工具，切走时 `dispose()` 旧挂载。修复端到端第 3 次"秘书没有 delegate 工具、自己写文件"的空挂。
- `inject` 增加 `agents`，用来在 `tools/change` 时枚举活着的 Agent；`agent/disposed` 时清掉挂载记录。
- 记录里带事件来源，日志能区分"创建时挂上"和"切预设后挂上"。

## v1.3 变更

- `delegate_leader`、`delegate_worker_frontend` 改走 `xindupx/claude-opus-5-5`。
- 两个领导预设：`tool-fs` 关闭 `write` / `edit`；人设改为"任何文件改动都派成员，不许用 shell 绕过"。
- `secretary-standard` 的 `customSkillDirs` 漏了 `!!js` 标签，是一段不会生效的字面字符串；官方 `standard` 预设本来就不带这项，已删掉，与官方一致（创造模式三个预设的写法本来就对，未改）。
- 创造模式团队不再自己安装或启用插件：领导在报告里给出 bundle 目录，由秘书征得用户同意后安装。
- 委派日志记录每个工具的实际路由与模块版本。

## 回退

卸载 bundle（`plugin_manager` 的 `remove_bundle`，或从 profile `package.json` 去掉 `@local/dsh-secretary-team` link）即可回到安装前状态。

profile 补丁的备份在 `system/runtimes/dsh-0.1.5-alpha.1/home/profiles/desktop/`：

| 备份 | 时点 | 内容 |
|---|---|---|
| `cordis.patch.yml.bak-20261101-secretary-team` | 04:37 | 装 bundle 之前 |
| `cordis.patch.yml.bak-20261101-claude-cli-xindupx` | 20:24 | 切 Claude Code 渠道到 xindupx 之前 |
| `cordis.patch.yml.bak-20261101-after-v16` | 21:35 | v1.6.1 上线后（当前可用状态） |
| `cordis.patch.yml.bak-20261101-disable-claude-tool` | 22:52 | 禁用全局 `tool-subagent-claude-cli` 之前（删掉那行 `disabled: true` 即可恢复 Claude Code 外包通道） |

只回退秘书团队时反而不需要文件备份：把 profile 里那行 `secretary-team-delegation` 改成 `disabled: true`，或把 bundle 从 `package.json` 摘掉，再触发一次热重载即可；回滚 bundle 版本则是 `git -C projects/dsh-secretary-team checkout <commit>`，改 `.mjs` 之后同样需要一次"配置变化"来触发重载（改一次 profile 补丁的注释即可，注意文件尾部换行）。

## 边界

- 领导不能直接问用户；需要用户决策的事写进报告，由秘书转达。
- 秘书没有 Team 工具（不会被 Team 注入影响），不会自己开团队。
- 深度固定 2：秘书 → 领导 → 成员；成员不能再往下派。
- 团队（领导和成员）不安装、不启用、不停用插件。
