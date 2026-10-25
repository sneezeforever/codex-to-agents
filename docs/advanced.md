# 进阶手册

[返回产品介绍和入门教程](../README.md)

日常使用可以直接在 Codex 里提需求。本页用于调整接入配置、直接调用 MCP 工具，以及维护本地后台。

## 配置执行端

所有命令在仓库目录中运行。默认数据目录是 `~/.codex-to-agents`；执行端接入、插件安装和管理命令应使用同一个 `--home`。

| 参数 | 适用场景 | 默认值或规则 |
|---|---|---|
| `--home` | 接入、插件安装、后台、监控等命令 | `~/.codex-to-agents`；位于本机磁盘，使用同一系统账户 |
| `--directory` | 启用执行端，设置默认任务目录 | 数据目录下的 `workspace/`；具体任务可以指定其他绝对目录 |
| `--provider` | DSH 必填；Hermes 可选 | DSH 传入 `'*'` 使用所有已加载提供方；具体 ID 用逗号分隔时作为允许列表 |
| `--codex` | `enable`、`disable`、`plugin-install` | 默认从 PATH 查找 `codex`；也可传入 CLI 的绝对路径 |
| `--profile` | DSH 接入 | 默认 `desktop` |
| `--dsh-home` | DSH 接入 | 默认 `~/.dsh` |
| `--hermes-url` | Hermes 接入 | 默认 `http://127.0.0.1:9120`，仅支持本机 loopback Dashboard |
| `--hermes-token-env` | Hermes 接入 | 可选，存放 Dashboard token 的环境变量名 |
| `--qoder-executable` | Qoder 接入 | 自动在本机查找 Qoder CLI；也可传入绝对路径 |
| `--transport` | `enable`、`plugin-install` | `stdio` 或 `http`；未保存过选择时默认 `stdio`；显式选择保存在数据目录并用于重装、看板安装和更新 |

下面以 Hermes Dashboard 运行在本机 9121 端口为例：

```bash
node src/command.mjs enable --executor hermes \
  --hermes-url http://127.0.0.1:9121 \
  --directory "$HOME/codex-agents-demo"
```

Qoder 接入使用 `enable --executor qoder [--qoder-executable ...] [--directory ...]`，不需要 `--provider`；`disable --executor qoder` 关闭并保留历史工作单。例如：

```bash
node src/command.mjs enable --executor qoder \
  --directory "$HOME/codex-agents-demo"
```

若未自动找到 Qoder CLI，再加 `--qoder-executable /绝对路径/qodercli`。

省略 Hermes `--provider` 时使用模型目录中的已配置提供方，任务可选择模型或使用 Hermes 当前默认模型。Hermes 自身的模型回退由 Hermes 管理。DSH 不会因提供方不可用而由本工程自动切换到其他提供方。

DSH 的 `--provider '*'` 是显式启用全部已加载提供方的模式，请保留引号，且不要与具体 ID 混用。模型目录按提供方和模型 ID 区分同名项。提供方从 DSH 移除后不可继续使用；某个提供方目录读取失败时，其他正常提供方仍可展示。沿用具体 ID 允许列表的旧配置不会自动扩大范围。

可先调用 `runtime_info` 查看提供方与模型 ID。显式指定模型时，使用目录返回的 ID；目录表示已配置，不保证模型凭据或上游服务此刻可用。

Hermes 的本地 Dashboard 临时 token 仅在内存中使用，不保存到工作单或配置。使用 `--hermes-token-env` 时，环境变量需对运行后台的进程可见；它不是模型 API 密钥。当前不支持远程 OAuth Dashboard 或切换 Hermes profile。

## 连接传输与代理

`enable` 和 `plugin-install` 都接受 `--transport stdio|http`，规则一致：

- **stdio（默认）**：Codex 启动 `src/command.mjs serve` 桥接；看板连接额外带 `--panel-only`。命令和参数分开传递，不经过 shell，因此数据目录含空格、单引号或中文也可用。桥接读取本机私有凭据，通过后台原有鉴权转发 MCP 消息，stdout 只输出协议内容。每个连接有一个轻量桥接进程，但所有连接仍复用同一个共享后台和执行消费者。
- **HTTP**：Codex 直接连接 `127.0.0.1` 上的 `/mcp` 或 `/board`，使用 `http_headers_helper` 按需启动后台并提供鉴权头。URL、插件 manifest 和命令行都不包含 token。HTTP 直连不会自动绕过宿主代理；若 `ALL_PROXY` 等代理未排除回环地址，请改用 stdio，或在宿主环境中自行放行 `127.0.0.1`/`localhost`。本工程不修改任何代理环境变量。

没有显式选择且数据目录没有保存值时使用 stdio。显式 `--transport` 会校验后写入数据目录的 `transport.json`，之后的重装、`plugin-install` 和看板更新都沿用该值。非法值在安装副作用前拒绝；保存文件损坏时会明确报错并保持原安装不变，不会静默换传输。切换传输不会自动重放状态不确定的任务，失败后先用原工作单编号核查。

`enable` 只注册或更新派工 MCP 连接，不会重写已安装看板的插件 manifest；返回结果会带 `board_sync_required` 和提示。要让现有看板使用同一传输，需再运行一次 `plugin-install`。`plugin-install` 会同时生成 `/mcp` 与 `/board` 的同一传输配置，不会混用两种字段。

## 自动派工设置

看板将开关、执行端、可选模型、思考强度和当前执行端的新会话权限保存到所选数据目录的 `delegation.json`，默认关闭，默认执行端为 Hermes。固定模型保存为 `route: { provider, model }`，省略 `route` 表示跟随执行端默认；显式思考强度另存为顶层 `effort`，只与固定 `route` 一起保存。省略 `effort` 表示跟随模型默认，不显式传递强度。三端权限分别保存为顶层 `dsh_permission`、`hermes_permission`、`qoder_permission`：`dsh_permission` 只接受 `read-only`、`workspace-write`、`danger-full-access`；`hermes_permission` 只接受 `yolo`；`qoder_permission` 只接受 `accept_edits`、`dont_ask`、`auto`、`bypass_permissions`。省略某字段表示跟随该端原生默认；保存 `"default"` 只清除该端字段；保存任一端时其他端字段原样保留。设置对使用该插件和数据目录的本机 Codex 会话共享生效。

模型列表来自所选执行端的模型目录。Qoder 的目录来自 `qodercli --list-models`：选择固定模型时新任务传 `--model`，不选时跟随 CLI 默认且不传该参数；目录未声明思考强度时不传 `--reasoning-effort`。打开看板或切换执行端时，后台异步加载该端运行时；界面继续显示连接状态，DSH 的模型查询不加载 Hermes。选择固定模型时校验提供方和模型组合，离线或模型已移除时拒绝新选择；已有固定模型离线时仍可关闭派工。思考强度只使用目录为该模型返回的 `efforts`：没有 `efforts` 的目录项不虚构选项，界面禁用强度选择并说明跟随模型默认；模型没有可用强度选项时不接受显式强度。切换模型或执行端会清除不兼容的强度，已有任务沿用原会话配置。切换执行端恢复为跟随默认，已有会话保留原模型和强度。

三个权限字段都只由看板设置，`work_submit`、`work_update` 等模型可调用接口不接受。各适配器只在新建派工会话时应用，续聊与追问沿用原任务记录的权限，不重新读取看板：DSH 在会话创建后、首条任务消息前通过原生 `permissionPresets` 应用对应预设并读回确认；Hermes 在 `session.create` 后、`prompt.submit` 前写入会话级 YOLO（默认 session 范围，不写全局审批设置），要求返回 `scope:"session"` 与 `value:"1"`，并尽力通过 `session.info` 读回；等不到事件时以写入接口返回的 scope/value 为准。Qoder 在启动 CLI 时传 `--permission-mode`，并以 CLI 返回的权限模式核对；不一致会终止并把任务标记为结果不确定。保存值不受支持或原生服务缺失时，会阻止新任务。DSH、Hermes 的权限应用与核对发生在首条任务消息前；Qoder 可能在任务已交给 CLI 后才收到权限回报，核对失败时任务结果保持待核查，不自动重放。

看板能力来自各执行端心跳中的权限能力声明。旧执行端没有该声明时，看板只允许跟随默认并提示更新或重新加载；DSH 旧心跳只有原生预设列表时仍按旧列表渲染。保存新的显式权限前，后台校验当前心跳是否声明该值，旧执行端或离线时拒绝保存；若磁盘上已保存显式权限而当前运行端不支持，`work_submit` 会在保存工作单前明确失败。`work_update` 续会话不重读该设置。

插件的 `UserPromptSubmit` Hook 经用户信任后，在每条用户消息到来时读取当前设置，并给 Codex 添加本轮派工偏好。设置读取失败按关闭处理。Hook 不投递任务、不记录用户提示、不修改全局 `AGENTS.md` 或工具权限；具体是否委派由 Codex 按需求和有效指令判断。

看板通过本机 Codex app-server 的只读 `hooks/list` 检查全局 Hook 配置，区分未信任、已更改、已停用、缺失与检查失败。仅发送初始化和读取请求，不建立模型会话、不修改信任。安装时在数据目录的 `plugin-installation.json` 记录 `--codex` 指定的 CLI；旧安装缺少此记录时需重新执行看板安装命令。多个可见看板共享检查缓存，最多每分钟复查，配置文件改变后提前复查；隐藏看板时不继续发起检查，查询结束退出临时进程。

全局 Hook 已信任不代表旧会话已加载插件。首次安装或更新 Hook 后，需要重新加载旧会话；正在运行的任务不受开关追溯控制。在 CLI 输入 `/hooks` 审核并信任当前定义后，看板更新状态；该审核保持由 Codex 原生信任流程完成。

开关只影响后续主动派工。已提交的任务继续跟进，明确指定 Agent 的请求仍按用户要求处理。设置写入工具仅对插件界面开放；浏览器监控保持只读。

## 共享任务文档

看板的 SDD 共享工作区用于存放目标、范围、计划和验收条件。工作区设置填写文档实际存放目录，默认是所选数据目录下的 `sdd`。项目仅按名称分类，每个任务一份 `task.md`。

切换文档目录后查看该目录中的项目和任务，原目录文件保留；已有旧版文档可继续从默认目录打开。设置不改变执行端代码工作目录，也不自动移动、合并其他文档。

展开文档区后才读取项目和任务，正文随选择按需加载，不加入定时快照，也不额外轮询。文档路径会完整显示，可在对话中交给两边 Agent 使用。自动派工的开关和 Hook 保持独立，保存文档不会触发执行任务。

SDD 任务文档开关位于看板设置区、始终可见，默认开启；旧配置缺少该字段时也按开启处理。关闭后 Hook 跳过文档保存和路径交接，但自动派工照常执行；`sdd_task` 的登记、创建和保存会被拒绝，读取仍可用。已有文件、目录设置和自动派工开关均保留。看板关闭开关时先处理未保存草稿，保存失败会回滚开关并显示错误。配置文件损坏时按关闭处理，且拒绝写入，不会默认开启自动写入。

自动派工开启时，Hook 要求 SOL 先保存已形成的开发任务规划，再在派工目标中引用实际文档路径。只要求规划时保存后交付，不调用派工；普通问答和讨论不创建文档。任务变更先读取原文档最新版本，再更新同一份任务约定。用户明确要求跳过文档时按其要求处理；保存失败时报告原因，不宣称已保存。

看板保存时核对读取版本。若另一看板或 Agent 已修改文件，拒绝本次覆盖并保留草稿；先保留需要的草稿，再重新读取最新内容合并。代码、实施记录和其他文档继续使用各项目原有位置。

看板通过仅对应用开放的 `panel_sdd` 管理文档和 SDD 开关；SOL 通过模型可见的 `sdd_task` 复用同一存储。模型工具支持读取工作区、项目分类、任务创建和文档读取/保存，不提供 `set_workspace` 或 `set_enabled`，`get_workspace` 会返回当前开关状态。新建任务时可一次写入完整规划，看板手动创建时仍提供模板。两种入口共用工作区标识、文档版本、大小和路径检查；文档写入在配置锁内再次核对开关，避免与并发切换竞态；HTTP 监控仍只读。

升级后若提示看板页面版本过旧，请关闭看板页面并重新打开。新版使用 `board/v3` 资源地址刷新页面缓存；旧页面缺少工作区标识的文档请求会被拒绝，不会写入当前工作区。

## 直接调用 MCP 工具

下面的 JSON 是 MCP 工具的 `arguments` 示例。常规聊天无需手写 JSON，直接用自然语言说明目标即可。

| 工具 | 用途 |
|---|---|
| `runtime_info` | 读取执行端心跳、模型目录和当前派工偏好 |
| `sdd_task` | 在看板选定的共享文档工作区保存和读取任务规划，不派工 |
| `work_submit` | 保存执行任务，立即返回工作单编号 |
| `work_update` | 保存追问、补充或取消单 |
| `work_inspect` | 读取某份工作单，或列出最近工作单；默认返回有界摘要，`view:"detail"` 返回完整记录 |
| `work_wait` | 只读等待某份工作单进入终态；单次调用有超时上限 |
| `workspace_control` | 保存 DSH 项目列表、注册、改名或移除操作 |
| `conversation_control` | 保存聊天列表、改名、归档或恢复操作 |

派工和执行端管理操作先返回工作单编号。项目列表和聊天列表同样通过工作单取得，再用 `work_inspect` 的默认摘要读取结果；需要完整记录时显式传 `view:"detail"`。`sdd_task` 直接返回文档结果与路径，不创建工作单。

### 检查执行端

给 `runtime_info` 传入：

```json
{ "executor": "hermes" }
```

Hermes 模型目录位于 `snapshot.catalog.models`。省略参数时返回三个执行端，位于 `executors.dsh`、`executors.hermes` 和 `executors.qoder`。查询 Hermes 或 Qoder 时会按需启动对应执行模块。

模型目录每 15 秒更新一次；心跳独立于任务轮询，每 2 秒发布一次，处理慢查询时也不会误显示离线。有未结束任务时每 750 毫秒检查一次，空闲时降到 2.5 秒，同进程新提交会立即唤醒。超过 6 秒未更新显示为离线。心跳证明最近有响应，不代表任务已成功。

### 提交和读取任务

给 `work_submit` 传入以下示例。`order_id` 可以省略，由系统生成；若要自行指定，必须在首次提交前用真实 UUID 生成器（例如 `crypto.randomUUID()`）生成，不能使用任务名、`cw-` 会话 ID 或示例占位符。下面的 UUID 只是示例，不要原样复用；首次提交与响应不确定时的重试必须沿用同一个 `order_id` 和完全相同的参数。示例使用接入时配置的默认目录和 Hermes 默认模型：

```json
{
  "order_id": "7d2615b6-a00f-42cb-8261-39900ec7c177",
  "executor": "hermes",
  "goal": "在默认任务目录创建 hello.js，输出 Hello, World!。只修改这个文件。",
  "title": "Hello World"
}
```

需要选择目录、提供方或模型时，添加 `directory`、`provider`、`model` 和可选 `effort`。`directory` 为执行端可访问的绝对目录，且应已存在。省略 `executor` 的底层工具请求使用 DSH；看板里的默认执行端不会改写这个工具默认值。使用 Qoder 时 `executor` 为 `qoder`，模型来自 `qodercli --list-models`；不选模型时跟随 CLI 默认，目录未声明思考强度时不传强度。

读取上面的示例请求，给 `work_inspect` 传入（默认返回有界摘要）：

```json
{ "order_id": "7d2615b6-a00f-42cb-8261-39900ec7c177" }
```

相同 `order_id` 和相同参数只发布一次；同一个 `order_id` 绑定不同内容会被拒绝。非法 UUID 会在保存前被拒绝，并提示 `order_id` 参数名及处理方式。响应丢失时，用原 `order_id` 和原参数检查或重试，避免换编号盲目重放，也不要用任务名、`cw-` 会话 ID 或示例占位符充当 `order_id`。

### 读取摘要与等待终态

带 `order_id` 的 `work_inspect` 默认返回有界摘要：工作单编号、类型、执行端、状态、创建/更新时间、`conversation_id`、截断后的进度/错误/最终结果文本、`truncated` 标志，以及精简的 `worker.online`。摘要不返回完整 events、output、goal、原生用量或模型目录。这是兼容性变化：需要完整记录的调用方和脚本必须显式传 `view:"detail"`，才会得到此前的完整记录；磁盘上的历史文件和状态语义不变，摘要只是读取视图。文本被截断时会带明确的截断标记和获取详细记录的提示，按提示传 `view:"detail"` 即可读取完整记录。省略 `order_id` 时仍按最近工作单分页列出，只附带精简的 `worker.online` 信息。

`work_wait` 是只读工具，必须传 `order_id`（UUID），`timeout_ms` 为整数，默认 45000、最大 55000 ms。它等待终态（`completed`、`failed`、`cancelled`、`blocked`）；`uncertain` 立即返回并带 `needs_attention: true`；超时返回 `timed_out: true` 和当前有界摘要，超时不代表成功，也不代表任务被取消。执行端离线不是完成。它绝不会提交、重放或取消工作。等待按单次调用限时，任何客户端都不能无超时地在后台永久唤醒，需要继续等待就再次调用。跨进程完成通过文件监听观察；监听可能漏事件时，按约每秒一次的频率只读目标工单的 requests/states 文件兜底，不会重建整个历史索引，也不是整个等待只读盘一次。

用默认摘要跟进、用单次有界等待代替反复查询，可以减少重复轮询带来的上下文重复读取；实际效果取决于工作单数量和记录大小，这里不做量化承诺。

### 继续任务或请求取消

给 `work_update` 传入以下参数，继续上面的示例任务：

```json
{
  "target_order": "7d2615b6-a00f-42cb-8261-39900ec7c177",
  "action": "append",
  "message": "把输出改为 Hello, Agents!，仍只修改 hello.js，并运行验证。"
}
```

`target_order` 继承原任务的执行端，不能改成另一执行端。也可用 `conversation_id` 替代 `target_order`，二者只能选一个；直接指向 Hermes 原生聊天时，需显式传入 `executor: "hermes"`。

| `action` | 行为 |
|---|---|
| `append` | 追问；Hermes 等前序工作单和原生会话均空闲后再投递 |
| `interrupt` | 补充指令；Hermes 使用原生 steer，受理成功不代表执行结束；Qoder 不支持运行中转向 |
| `cancel` | 请求取消当前活动；不需要 `message`，原任务状态需另行检查 |

Hermes 的取消会清理原生待发消息，但本工程尚未投递的追问单仍保留。DSH 会保留原生排队消息。已经开始的工具操作不保证立即中断。

### 管理项目和聊天

`workspace_control` 仅支持 DSH，提供 `list`、`register`、`rename`、`remove`。Hermes 与 Qoder 使用任务目录，不支持 DSH 式桌面项目注册。移除 DSH 项目注册保留文件与聊天历史。

`conversation_control` 对 DSH 与 Hermes 提供 `list`、`rename`、`archive`、`restore`；Qoder 没有经过验证的会话管理命令，这些操作会被明确拒绝。操作已有聊天时，使用 `work_inspect` 返回的 `conversation_id`；它与工作单编号不同。归档运行中的聊天需显式设置 `stop_running: true`。管理操作不是跨系统事务，失败后需核对是否已产生部分变更。

### 理解任务状态

| 状态 | 含义与下一步 |
|---|---|
| `queued` | 已保存，等待所选执行端领取 |
| `dispatching` | 正在创建会话或交付操作 |
| `executing` | 已提交给执行端，继续查看进度 |
| `completed` | 已取得完成结果，仍需核对实际产物 |
| `failed` | 执行失败，查看错误及原生记录 |
| `blocked` | 已阻塞，按错误原因处理 |
| `cancelled` | 已取消，核对原生执行状态 |
| `uncertain` | 交付或终态不明，先检查原生聊天和文件，系统不自动重投 |

任务、状态和结果保存在本机。执行端离线时，工具仍可保存工作单；执行端恢复后继续领取。自动派工流程会先检查在线状态。

执行端完成后的最终回复按统一约定自报：完成或阻塞、改动文件、实现摘要、验证命令与退出码/通过数、未验证项和需要 SOL 决策的事项；不粘贴完整源码、不扩大范围，已有相关证据时不机械重跑整个测试套件。若用户或原任务明确要求了输出格式（例如 JSON、补丁、固定标记）或验收方式，该格式要求优先：统一约定只要求在指定格式内补充证据，不会追加另一种格式或改写原格式。该格式是执行端自报信息，不构成独立验证，仍需结合摘要与文件证据核对实际产物。

Hermes 原生终态先保存到持久回执，重启后恢复已确认结果。若断线期间漏掉终态，只展示本单原生记录并保持 `uncertain`，不会把“会话已空闲”当作任务成功。

## 管理共享后台

```bash
node src/command.mjs backend status
node src/command.mjs backend restart
node src/command.mjs backend stop
```

同一数据目录的 `/mcp` 派工连接和 `/board` 看板连接共用一个 `agents-backend`，无论它们使用 stdio 桥接还是 HTTP 直连。后台仅监听 `127.0.0.1`；HTTP 模式的 `http_headers_helper` 在建立连接时确保后台已启动，并提供本机私有认证头。认证值保存在 `backend-auth.json`，权限为 `0600`，不放进 URL 或插件配置。stdio 桥接也读取同一凭据，并复用同一个后台、工作单和租约。

重启复用原端口，保留工作单和会话记录。DSH、Hermes 已接收的原生任务可继续运行；Qoder CLI 子进程会随消费者关闭而终止，尚未确认的结果保持待核查，不会自动重放。停止后台不会卸载插件；之后新建 MCP 连接会按需启动后台。

`serve` 命令（可加 `--panel-only`）是 stdio 传输使用的入口，也是到共享 HTTP 后台的轻量转发。显式传入 `--hermes-url` 时，会将该设置保存为数据目录共用的 Hermes 配置。

共享后台会处理尚未完成的 Hermes 工作，关闭某个客户端不会停止它。需要单独在前台调试消费者时，可运行：

```bash
node src/command.mjs worker --executor hermes
```

同一数据目录只允许一个 Hermes 消费者。已有独立消费者时，共享后台等它退出后按需接管。

## 使用终端或浏览器监控

查看一次终端快照：

```bash
node src/command.mjs monitor --once
```

打开本机浏览器监控服务：

```bash
node src/command.mjs monitor --web
```

浏览器打开终端打印的地址，默认端口 `18862`，用 Ctrl+C 停止监控服务。浏览器监控只读，自动派工开关需在 Codex 内嵌看板中设置。

这里的浏览器服务是单独启动的可选只读设置预览，不是插件后台的 `/board` MCP 地址；不要把两个端口混用。任务明细使用终端监控或 Codex 的 `work_inspect` 查询（默认有界摘要，需要完整记录时传 `view:"detail"`），等待终态可用 `work_wait`；派工共享后台 PID 使用 `backend status` 查看。

## 更新与停用

### 更新已有安装

首次从没有更新入口的旧版升级，请先按[旧版升级步骤](upgrading.md)更新原来的 clone 目录，并沿用原安装参数。

更新代码并安装依赖后，重新生成和安装插件，再重启后台与 Codex：

```bash
npm ci
node src/command.mjs plugin-install
node src/command.mjs backend restart
```

已保存的 `stdio`/`http` 选择会被自动沿用，无需再次传入 `--transport`。只使用派工工具时，可以重新执行对应执行端的 `enable` 代替安装看板；`enable` 会沿用已保存传输，但不会刷新既有看板，需要看板同步时仍要运行 `plugin-install`。更新 DSH 插件源码后，需要重新执行 DSH 接入命令并重启 DSH，使其载入新的代码快照。

看板折叠的「插件更新」区可检查并安装 GitHub 默认分支更新。安装更新会同时重建看板连接，并使用 `plugin-installation.json` 中记录的 Codex 路径刷新派工连接、重新执行插件的 `marketplace add`/`plugin add`，让 Codex 已安装的插件缓存也切换到同一个传输；三者沿用同一个已保存传输。若注册或插件安装失败，更新会报告安装失败并保留重试入口，不提交新的传输选择。看板首次可见且连接成功时调用 `check_daily`，多个看板通过本地数据目录共享检查记录，每 24 小时最多自动检查一次；失败也计入尝试。近期手动检查会抑制重复自动检查，尚未完成的安装先保留恢复入口。有新版时折叠栏显示提示，由用户决定是否安装；手动「检查更新」不受自动检查间隔限制。单独查看状态只读取本地缓存，不访问远端。

检查与安装由后台助手执行，看板在操作后做有限的状态查询；预算用尽而更新仍在进行时提供只读「刷新状态」重查本地缓存，不新增常驻轮询。临时连接中断按可重试的读取错误提示，不宣告安装失败。若上次依赖或本地插件安装未完成，状态会带 `pending_install` 并保留「安装更新」重试入口，重试只补安装、不重复合并代码。安装只在本机安装目录的当前分支可快进、且没有 tracked/staged 改动和正在运行的任务时执行；存在本地改动、分叉、离线或忙碌时会阻止并说明原因。更新不使用 stash、reset 或强推，也不删除未跟踪的 SDD 文档。完成后需要重新加载 Codex 或重启 DSH 才能使用新版本，本工程不会自动重启原生应用。该能力通过仅应用可见的 `panel_update` 提供，模型工具目录不包含它。

从旧版升级时，如果数据目录还没有保存的传输选择，重装和看板安装会采用默认 stdio；需要继续使用 HTTP 时，在首次 `enable` 或 `plugin-install` 加上 `--transport http`，之后会沿用该选择。重启 Codex 以载入新的连接配置。若 DSH 仍运行不区分执行端的旧消费者，系统会拒绝保存 Hermes 单据；重新启用 DSH 并重启它后再试。

### 停用某个执行端

停用 Hermes：

```bash
node src/command.mjs disable --executor hermes
```

共享后台会在约两秒内读取新设置并关闭内置 Hermes 消费者，保留 MCP 注册、DSH 设置和工作单。独立启动的 `worker` 需另外退出。

停用 DSH：

```bash
node src/command.mjs disable
```

该命令卸载 DSH 执行插件；未启用 Hermes 时也移除派工 MCP 注册。DSH 仍需完成配置重载，未自动生效时重启 DSH。插件看板与共享后台仍可独立存在，单据、文件和备份保留。

停用 Qoder：

```bash
node src/command.mjs disable --executor qoder
```

关闭 Qoder 配置并保留历史工作单，不影响终端里你自己运行的 `qodercli`。

停用执行端前，可以先关闭自动派工，避免新的自动任务。需要停止已经接收的工作时，先提交取消请求并核对结果。DSH、Hermes 的原生任务可继续运行；Qoder CLI 子进程会随消费者关闭而终止，未确认结果保持待核查。

## 开发与验证

自动测试：

```bash
npm test
```

覆盖工作单发布与幂等提交、消费者排他、恢复、模型限制、结果关联、HTTP 共享后台、stdio 转发、传输选择持久化与损坏拒绝、代理环境下 stdio 连接、看板隐藏/恢复、模型偏好与三端新会话权限保存、Hook 就绪检查、SDD 开关独立持久化与关闭时拒绝写入，以及已完成历史缓存与增量更新。Qoder 的提交、续聊、取消和错误处理由隔离 CLI 夹具验证。这不等于所有模型和客户端组合都完成业务验收。

DSH 实机脚本：

```bash
node scripts/desktop-check.mjs
```

脚本使用 DSH `desktop` profile 和 `deepseek-account` / `deepseek-flash`，临时加载测试执行插件并发送少量真实模型请求；如果已有本工程的消费者插件，则拒绝修改现有配置。结束后恢复测试插件配置。

Hermes 实机脚本：

```bash
node scripts/hermes-check.mjs
```

使用 Hermes 当前默认模型，可通过 `--provider` 和 `--model` 覆盖。在独立目录内验证文件产出、幂等重试、两条排队追问、共享连接、后台重启及聊天管理，会产生少量真实模型请求。测试聊天在结束时归档并关闭其原生运行资源，测试后台随后停止。

两个实机脚本都会访问执行端并发送真实模型请求，不是离线单元测试。源码职责、持久化和恢复策略见[设计说明](../DESIGN.md)。正式发布前还需确定本工程许可证并审核依赖许可。
