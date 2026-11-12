# 剩余工作与已核实的协议事实

> 记录人：bg1 上的助手，2026-11-07。本文件只写**实测/读码确认过**的东西，未确认的一律标注。

## 已完成（均已用 `test/harness*.mjs` 在同源 Chromium 环境验证并出过包）

| 版本 | 内容 |
|---|---|
| 1.0.0 | 会话列表 / 对话 / 流式输出 / 工具卡 / 思考折叠 / 发文本与图片 / 中断 / 新建 / 重命名 / 换模型 |
| 1.1.0 | `$events` 转发流：审批卡片、反问卡片（`waterfall` → `POST /api/$events/result`）；权限预设切换 |
| 1.2.0 | 会话搜索、新建选工作目录、命令面板、消息复制/重发/分叉、统计条、底部弹层与 SVG 图标 |
| 1.3.0 | 文件浏览器 + 文本预览、后台任务（含结束）、长期目标、模型供应商/插件清单 |
| 1.4.0 | 轨迹视图（按回合聚合步数/工具/耗时，点击跳转） |
| 1.5.0 | 会话信息面板（计划/待办/交付物/子代理/用量） |
| 1.11.2 | **子代理会话不再和正常会话并列**：照 Host 的 `flattenLineage` 规则缩进挂到父会话下（父不在列表时退化为顶层、绝不丢）；分叉会话仍并列并标「分叉」；打开子代理时标题栏标明「子代理 · 父会话」 |
| 1.11.1 | **修「每推进一步就刷新聊天框、打不进字」**：follow 流每来一条 `assistant/message` 都会调 `loadSessions()`，而它结尾 `render()` 重建整页（textarea 被销毁、焦点丢失）；现在列表刷新不再重绘当前视图，另加草稿保留兜底 |
| 1.11.0 | **发出的图片能看了**（原来渲染成 `［图片］` 文本）：按 `attachmentId` 走 `session/attachment` 取回并内联显示，点开可全屏；**忙时排队**有了可见反馈：队列条显示待发条数、内容、可逐条移除 |
| 1.10.1 | **附件移到独立一行**（不再挤在横向滚动的 chip 行里）；长文件名中段省略并保留扩展名，删除按钮固定右侧、永远可点；图片显示缩略图 |
| 1.10.0 | **附件上传补全**：壳层实现 `onShowFileChooser`（原来点"+"在手机上毫无反应）+ 任意文件走 `POST /api/session/uploadFileBinary` 拿 `receiptId` 挂进 prompt；图片仍走内联 base64 |
| 1.9.3 | 抽屉改为**按工作区归属分组**（与桌面端一致），不属于任何工作区的会话归到「未分组」并在行尾标出所在目录名；顺手清掉测试遗留在 `scratch` 的 7 个空会话 |
| 1.9.2 | **模型/权限浮层可以退出了**（原来只能选一个才能关）；**工作区目录可折叠**（记住折叠状态）；**空会话折叠成一行**不再刷屏；composer chip 加 `data-chip` 标识 |
| 1.9.1 | **修登录页反复刷新**（未登录时 WebSocket 403 重连 → 整个界面重绘 → 密码框被清空，根本没法输入）；顺带修设置面板测试自身的时序竞态 |
| 1.9.0 | **适配 dsh 0.2.2-rc.1**（终端上行流、定时任务新 API + 新建/立即执行/暂停恢复）+ **桌面化 UI**（抽屉侧栏、助手正文去气泡、回到最新浮标、代码块复制）+ 修掉 http 下复制失效的真 bug |
| 1.8.1 | **滚动三修**：打开会话直接落到最新消息（之前停在最上面）；「载入更早的消息」按高度差补偿，阅读位置不再被打飞；回合结束重绘不再跳回顶部。断言在 `test/scroll-local.mjs` 与 `test/jump-local.mjs` |
| 1.8.0 | **设置可写**：凭据（9 个 API Key，改/清）、20 个配置项的标量字段编辑（带 revision CAS，过期即拒）、203 个插件清单 + 启停；**技能面板**（`skills/list`，9 个技能，可复制名称/SKILL.md 路径） |
| 1.7.0 | **定时任务面板**（本会话 / 全部会话两种范围、规则与下次触发、详情、删除）+ **工作区管理**（`workspace/follow` 订阅、置顶、归档箱恢复、改名、登记/删除、按工区看会话、会话长按菜单、主列表隐藏已归档） |
| 1.6.0 | **终端**：xterm 6.0.0（与宿主同版本，从 GUI 包里抽出内置）+ `terminal/*` 全套；多 shell、键栏、自适应尺寸、重开复用同一进程、明暗跟随 |

## 剩余工作

1. ~~终端面板~~ ✅ 1.6.0
2. ~~定时任务面板~~ ✅ 1.7.0（只能查看/删除；任务由模型用 `schedule_create` 建，RPC 层没有 create）
3. ~~工作区管理~~ ✅ 1.7.0（置顶/归档/改名/登记/删除/排序接口已确认，排序 UI 未做）
4. ~~设置写操作~~ ✅ 1.8.0（凭据 / 配置项 / 插件开关都通了）
5. UI 细活：面板转场动效、归档箱分页（27 条一次全画）、设置面板按分组折叠（现在是一条长列表）
6. 技能只能看不能装（`add_skill` 是模型侧工具，没有对应 RPC）

## 已核实的协议事实（避免重复踩坑）

一元调用：`POST /api/<endpoint>`，体 `{type:'client-request', rpcId, method, payload:{args}}`；
`args` 的键**必须是参数名且精确匹配**（多/少一个键 → `gateway/arguments-invalid`）。

流：`WS /api/remote.mux`；客户端 `{type:'open', streamId, endpoint, payload:{args}}`、
`{type:'item', streamId, value}`、`{type:'end', streamId}`；服务端 `item` / `end` / `error`。

已确认的端点签名（`lib/typert.remote-client.d.ts`）：

```
session/list(_request)            session/page(request)   session/follow(request)*
session/prompt(request)           session/cancel(request) session/create(request)
session/rename(request)           session/fork(request)   session/search(request)
session/modelCatalog()            session/selectModel(request)
session/projections(request)      session/attachment(request)
commands/list(agentId)            commands/execute(agentId, line, submittedAttachments)
skills/list(request)              permissionPresets/catalog()
workspaceFiles/list(workspaceFileScopeId, path)   workspaceFiles/read(workspaceFileScopeId, path, range)
workspaceFiles/stat(workspaceFileScopeId, path)   workspaceFiles/readBytes(workspaceFileScopeId, path, options)
job/list(request)*                job/kill(request)
goals/get(agentId)                goals/create|edit|pause|resume|complete|clear
schedule/list(request)            schedule/catalog()      schedule/delete(request)  schedule/update(request)
terminal/create(agentId, request) terminal/follow(agentId, id, attachmentId)*
terminal/write(agentId, id, attachmentId, data)  terminal/resize(agentId, id, attachmentId, cols, rows)
terminal/list(sessionId)          terminal/retain(sessionId, id)*  terminal/close(agentId, id)
terminal/shells(agentId)          terminal/environment(agentId)  terminal/rename(agentId, id, title)
llm/listProviders()               pluginInventory/list()
workspace/create|rename|delete|follow*|pinSession|archiveSession|unarchiveSession|unpinSession
```

`*` = 流式，只能走 WS（HTTP POST 会 `gateway/signature-invalid`）。

### 转发事件流 `$events`

无握手即可订阅（open 的 args 传 `{}`）。帧：

```
{type:'ready', clientId, host:{home}}                     // 必须存下 clientId
{type:'emit', event, args}                                // 通知，无需回
{type:'waterfall', event, eventId, agentId, request}      // 必须回执，否则回合卡死
{type:'cancel', eventId}                                  // 撤回一个待处理请求
```

回执：`POST /api/$events/result`，`args = {clientId, eventId, outcome}`；
`outcome` ∈ `{kind:'next'}` / `{kind:'result', value}` / `{kind:'rejected', error}`。

两个 waterfall：
- `approval/request` → `request: {toolName, callId?, reason?, displayReason?}`，`value` = `'allowed-once' | 'rejected'`
- `user-questions/request` → `request: {questions:[{id, question, header?, detail?, options?:[{label,description?}], multiSelect?}]}`，
  `value` = `{answers:[{id, selected:[label...], custom?}]}`

### 终端协议（2026-11-07 全链路实测）

```
environment(agentId) -> {cwd, maxInputBytes:65536, maxCols:500, maxRows:200, scrollback:1000}
shells(agentId)      -> [{path,name,args}]  // bg1: cmd.exe, bash(-i), pwsh(-NoLogo), powershell(-NoLogo)
list(sessionId)      -> WebTerminalInfo[]   // 注意是 sessionId，不是 agentId
create(agentId,{id,shellPath?,cols,rows}) -> WebTerminalInfo     // id 由客户端自己 uuid，幂等
retain(sessionId,id) 流 -> [{type:'retained'}]                    // 窗口持有，停止空闲回收调度
follow(agentId,id,attachmentId) 流 -> snapshot / output / state
close(agentId,id) | rename(agentId,id,title)
```

- **attach 即抢控制权**：`follow` 会把 `info.controllerId` 设成你的 attachmentId，旧的变只读；
  `writable = info.state==='running' && info.controllerId===attachmentId`。
- 帧：`{type:'snapshot',sequence,screen,info}` / `{type:'output',sequence,data}`（sequence 必须连续，
  断号就重新 attach）/ `{type:'state',info}`。**snapshot 的 `screen` 是 `@xterm/addon-serialize` 的输出**，
  所以前端必须跑**同版本 xterm（6.0.0）**才能正确重放；因此 `app/src/main/assets/www/vendor/xterm.js`
  是用 `tools/extract-xterm.mjs` 从 GUI 的 `client.terminal.js` 里**原样抽出来的 UMD**（xterm 6.0.0 + addon-fit 0.11.0），
  首次打开终端时才懒加载，不影响启动速度。
- 不持有（`retain`）时，空闲 **2 小时**（`unattendedTimeoutMs`）会被回收；每会话最多 **8** 个终端。
- 退出浮层**不结束进程**：重进会用 list 里同一个 id 重新 attach，snapshot 把历史屏幕补回来。

### `schedule/*` 与 `workspace/*`（2026-11-07 实测）

**最大的坑：这些方法只有一个名为 `request` 的参数，args 必须写成 `{request:{...}}`**，
平铺字段会报 `args fields do not match the descriptor: missing "request"; unexpected "<field>"`。
（`terminal/*`、`commands/execute`、`goals/get` 相反：那些是多个具名参数，平铺才对。）

```
schedule/catalog()                                  -> ScheduleCatalogEntry[]（全机）
schedule/list({sessionId})                          -> ScheduleRecord[]（按 kind 区分的联合）
schedule/delete({sessionId, id})                    -> {id, deleted:boolean}
schedule/update({sessionId, id, expected, title?, prompt?, change?})  // expected=整条旧记录，做 CAS
schedule/history({sessionId, id, limit, before?})   -> 投递记录
workspace/follow 流                                 -> {type:'baseline', value:{items, archivedSessionIds, pinnedSessionIds}}
                                                       + upsert / remove / order / archived / pinned 增量
workspace/create({path}) | rename({workspaceId,title}) | delete({workspaceId})
workspace/pinSession({sessionId}) | unpinSession({sessionId}) -> {pinnedSessionIds}
workspace/archiveSession({sessionId, stopActivity?}) | unarchiveSession({sessionId}) -> {archivedSessionIds}
workspace/insertBefore | insertSessionBefore        -> 排序（UI 未做）
directoryPicker/list({path?})                       -> DirectoryListing
```

- 工作区**只能通过 `workspace/follow` 流读取**，没有普通 list；客户端要一直持有这条流
  （置顶/归档集合也只在流里，靠它才能把已归档会话从主列表收起）。
- `archiveSession` 对**有活动**（回合、子代理、后台任务、活跃定时任务）的会话会拒绝并回
  `workspace/session-active` + `activity` 列表；要强推得传 `stopActivity:true`（不等待停止）。
- 定时任务**没有 create 类 RPC**——任务由模型的 `schedule_create` 工具建；客户端只能 list/delete/update。
- `ScheduleRecord` 是判别联合：`after`(afterSeconds) / `at` / `every`(everySeconds) / `daily`(time,timeZone) /
  `weekly`(time,timeZone,weekdays) / `cron`(expression,timeZone)，都带 `title`、`prompt`、`scheduledAt`。
  `schedule/catalog()` 的条目额外带 `sessionId`、`status`、`lastDelivery?`。

### `settings/*`、`credentials/*`、`pluginManager/*`、`skills/*`（2026-11-07 实测）

```
settings/describe()                                  -> {writable, hasDocument, namespaces:[{ns,schema,value,base?,user?,
                                                        applies:'live', secrets:[{path,set}], revision}]}
settings/mutate(ns, ops, expectedRevision?)          -> SettingsNamespaceView
     ops = [{op:'set', path:[...], value}] | [{op:'unset', path:[...]}]
settings/update(ns, patch, expectedRevision?)        -> 浅合并
settings/replace(ns, section, expectedRevision?)     -> 整段替换
credentials/describe(refs: string[])                 -> {ref:{configured, source, writable}}
credentials/set(ref, value) | credentials/unset(ref)
pluginManager/listPlugins()                          -> 203 条 {entryId, moduleName, enabled, fiberPhase,
                                                        readOnlyReason?, meta?{title,description}, patchId?}
pluginManager/listBundles()                          -> 20 个 bundle {name, version, description, meta?}
pluginManager/setPluginEnabled(id, enabled)          -> {stage, target, enabled, changed, application, warnings}
pluginInventory/list()                               -> {entries, agentPresets, managementAvailable}（旧入口，字段名不同）
skills/list({sessionId})                             -> {skills:[{name, description, whenToUse?, path?, modelInvocable?}]}
```

- **凭据 ref 不是猜的**：ref 就是各命名空间值里声明的 `apiKeyEnv` 字符串（如 `SENSENOVA_API_KEY`），
  扫一遍 `settings/describe()` 的 `value` 树就能拿到全部 ref；`credentials/describe(该数组)` 一次查齐是否已设置。
- **`expectedRevision` 可以省略**（省略即无条件写），带上则是 CAS：过期会被拒、**不会落盘**（实测 rev 不变、user 层不变）。
  编辑 UI 一定要带，否则并发改配置会静默覆盖。
- 秘密字段永远不上线：`value` 里被 redact，状态只从 `secrets[{path,set}]` 读；写密钥走 `credentials/set`。
- 布尔/字符串/数字可以直接 `settings/mutate` 到 path；**数组和嵌套 >2 层的对象没做编辑**（列表类字段目前只能看）。
- `pluginManager/setPluginEnabled` 会**重写 profile 的 `cordis.patch.yml`**（即使值没变也报 `changed:true`），
  `readOnlyReason`（`unaddressable` / `management-required`）的条目不能开关。命令行验证配置是否仍然合法：
  `dsh --profile web --dump-config`（退出码 0）。

### dsh 0.2.2-rc.1 破坏性变更（2026-11-10 实测）

升到 0.2.2 后，**终端与定时任务两块直接失效**，根因是端点被删/改名：

| 0.2.0-rc.2 | 0.2.2-rc.1 | 处置 |
|---|---|---|
| `terminal/follow` + `terminal/write` + `terminal/resize` | **只剩 `terminal/attach`（双向流）** | 上行改成 `{type:'item',streamId,value:{type:'write',sequence,data}}` / `{type:'resize',sequence,cols,rows}`，sequence 每个 attachment 从 1 连续递增；下行新增 `ack` 帧（含 `refusal`）；可写性改读帧里的 `writable`，不再比对 `controllerId` |
| `schedule/delete` / `schedule/update` | `schedule/edit({id, action:'update'|'delete', patch?, expectedUpdatedAt?})` | 删除= `action:'delete'`；改= patch |
| `schedule/list` 返回数组 | 返回 `{items,shown,total,limit,offset}`，**全机**+分页（`active?` 过滤） | 面板改为全机列表 + 筛选 |
| 任务记录 `daily/weekly/cron` 字段 | **`kind:'rrule'` + `rrule` 字符串**，并带 `status: active|paused|ended`、`target`、`lastDelivery`、`createdAt/updatedAt` | 写了个 rrule 人话解析（FREQ/INTERVAL/BYDAY/COUNT + DTSTART 时刻） |

**0.2.2 新增、手机端用得上的**：`schedule/create`（客户端终于能自己建任务）、`schedule/run`（立即执行一次）、`schedule/view`、`schedule/deleteInactive`（批量清理已结束）、`schedule/deliveryLimits`。
**其他新增但本轮没接**：`session/updateQueue`（回合中排队消息）、`actionCards/act`（模型给的可点卡片）、`speech/*`（语音输入，experimental）、`messageFeedback/*`、`workspaceFiles/changes`、`fileReferences/list`、`llm/discoverModels`、`pluginMarket/*`、`forgePanel/*`、`remoteAccess/follow`。

**不变的部分**：`approval/request` 与 `user-questions/request` 两个 waterfall 名字和行为没动，`$events` 契约照旧；`session/follow`、`terminal/retain`、`workspace/follow`、`settings/*`、`credentials/*`、`skills/list`、`workspaceFiles/*` 都没变。

**环境变化**：3080 现在只绑 `172.16.0.59`（公网 `36.138.189.24:3080` 仍可达，靠端口转发），新增 `8443` TLS 只绑内网、公网连不上；升级后登录 cookie 全部失效，测试台状态要用 `tools/refresh-state.mjs` 重新抓。

### 登录页「反复刷新、打不进密码」（2026-11-10 修复）

**现象**：手机端未登录时登录界面不停刷新，密码框里打的字会被清掉。

**根因（不是登录逻辑，是实时通道的重连风暴）**：`run()` 在看是否登录之前就 `mux()` + `attachForwardedEvents()`，
未登录时 `/api/remote.mux` 握手返回 **403** → `ws.onclose` → `scheduleRetry()` **并且 `render()`**；
`render()` 在 `S.view === 'login'` 时走 `renderLogin()`，那里 `mount()` 会 `app.innerHTML = ''` 整棵树重建
→ 输入框被销毁（焦点丢失、已输入内容丢失）。退避是 500·1.7^n，前几秒约每秒一次，所以看起来像页面在刷新。

**修法**（四处，都在 `app.js`）：

1. 新增 `S.authed`；`Mux.connect` / `scheduleRetry` 在未认证时**直接不连**。
2. `ws.onopen` / `ws.onclose` 里的 `render()` 在 `login`/`setup` 视图下**跳过**。
3. `run()` 改成先 `loadSessions()`，成功后才开 mux；`loadSessions` 成功即置 `S.authed = true`。
4. `showLogin()` 把 mux 彻底关掉（`closed = true` + `ws.close()` + 置 null），不留重连在后台跑。
   另外密码框的值存进 `S.loginPass` 并在重绘后回填 + 自动聚焦。

**验证**：`test/harness-login.mjs`（未带 cookie 的全新上下文）—— 修前 6 秒内 **6 次重建**、输入被清空、
控制台刷 5 条 `remote.mux 403`；修后 **0 次重建**、输入保留且保持焦点、登录后正常进列表、控制台干净。

### 子代理会话为什么和正常会话并列（2026-11-12 修复）

**现象**：子代理（subagent）会话在会话列表/抽屉里和普通会话平铺并列，看起来像一堆重复的会话。

**桌面端的规则**（`dsh-api-session-controller/lib/types/client/sessions/lineage.js` 的 `flattenLineage`，
原文注释写得很清楚）：

- `origin === 'subagent'` **且** 父会话也在列表里 → 变成父会话的**子行**（`depth + 1`），紧挨父会话渲染；
- **普通分叉（fork）**虽然也带 `parentSessionId`，但 `origin` 不是 subagent → **仍是顶层**（注释：*"Historical ordinary forks may retain a parent id without being subagents"*）；
- 父会话不在列表里（孤儿）→ **退化为顶层，绝不丢**；有环时也当顶层输出。

本端原来只给子代理打了个「子代理」标签（`app.js:896`），没有任何层级处理，所以看着就是并列。

**修法**：把 `flattenLineage` 一模一样的纯函数搬进 `app.js`，列表（`visibleSessions`）与抽屉（按工作区分组后）
都走它；缩进行加左侧竖线 + `↳` + 「子代理」标签，分叉行标「分叉」；打开子代理时标题栏显示
「子代理 · 父会话：<父标题>」。**没有隐藏任何会话** —— 与桌面端一致：缩进而不是丢弃。

**实测数据**（当时列表）：130 个会话，其中 `origin === 'subagent'` 3 个（全部能嵌套）、
带 `parentSessionId` 但非子代理的**分叉 4 个**（必须保持并列）。`harness-lineage` 7/7：
缩进行确实是子代理且紧跟其父、父在列表里的子代理 0 个并列、分叉仍并列且有标签、抽屉同样嵌套、
打开子代理时标明父会话。

### 每推进一步就刷新、打不进字（2026-11-11 修复）

**现象**：助手每推进一步（每条消息/工具调用），聊天区就重建一次，输入框里打的字被清空、键盘焦点丢失。

**根因**（一步到位的因果链，不是猜的）：

```
onFollowFrame(event)
  └─ if (ev.type === 'assistant/message' || 'turn/end') loadSessions()
       └─ loadSessions() … render()          ← 结尾无条件重绘
            └─ render() → renderChatView()   ← S.view === 'chat' 时整页重建
                 └─ composer() → 新建 <textarea>   ← 旧节点连同已输入内容一起销毁
```

也就是说：**列表数据更新顺手把整个会话页重画了**。手机上一轮里会有很多步，于是表现为"一直在刷新、根本没法输入"。

**修法**：

1. `loadSessions(opts)` 支持 `{repaint:false}`；follow 流里只更新列表数据、不重绘当前视图。
   其他调用点（会话列表页的 30s 轮询、切回前台）保持重绘，行为不变。
2. 兜底：新增 `S.draft`，输入即记录、`composer()` 建新 textarea 时回填、发送成功才清空。
   这样即使将来因为主题切换等原因真的整页重建，草稿也不会丢。

**A/B 证据**（`tools/probe-typing-ab.mjs`，一次性会话，纯客户端断言）：

| 路径 | textarea 是否同一个节点 | 焦点是否还在 | 内容 |
|---|---|---|---|
| 旧行为 `loadSessions()`（重绘） | **false**（被替换） | **false** | 值还在但焦点已丢 |
| 修复后 `loadSessions({repaint:false})` | **true** | **true** | 保持 |
| 强制整页重建 `renderView()` | 新节点 | — | 草稿回填成功 |

另有 `test/harness-typing.mjs` 做真实场景：在**真跑动**的一轮里逐字输入 10 个字，10/10 次采样时 `running=true`，
最终 `typed="这是跑着的时候打的字"`、焦点保持 —— 5/5 通过。

### ⚠️ 事故：探针误伤了真实会话（2026-11-11）

写上面那个 A/B 探针时，为了"挑一个能用的会话"，它按**回合数最多**去选 —— 选中的正是用户真实在跑的会话，
而且脚本末尾带了一句 `session/cancel`。结果上一次工具调用被中断时，用户的实时回合 `turn/end` 记录为
`aborted`（seq 5156）。核对结果：**模型没有被切**（仍 `wb2api / cn:deepseek-v4.1-flash`）、
**没有塞进任何多余 prompt**（日志里只有用户自己的消息），但"打断当前回合"这件事本身已经发生。

**新增硬规则（比"测试不要碰真实会话"更严）**：

1. 任何会写状态的探针/测试（`session/prompt`、`session/cancel`、`session/updateQueue`、`session/selectModel`…）
   **必须自己 `session/create` 一个一次性会话**，用完归档；
2. **禁止用"回合数最多/第一个非归档"之类的启发式来挑会话**去执行写操作 —— 那必然是用户正在用的那个；
3. `session/cancel` **只允许**作用于本脚本自己创建的会话；对真实会话连"收尾清理"都不许；
4. 只读操作（`session/follow`、`session/attachment`、`session/state`）可以看真实会话，但也要显式传 `--session`，
   不要靠猜。

### 发出的图片变 `［图片］`：附件被服务端持久化（2026-11-11 修复）

**现象**：手机端发出去的图片在对话里只剩一行 `［图片］` 文本，点不开也看不了。

**根因（实测记录，不是猜的）**：`session/prompt` 提交的内联 base64 会被 Host **提升为持久附件**，
所以会话日志里存的不是 `data`，而是：

```json
{ "type": "image", "attachment": { "attachmentId": "sha256:befa…", "mediaType": "image/png",
                                   "width": 1082, "height": 2363, "bytes": 58539, "name": "shot.png" } }
```

而 `blocksText()` 把所有非文本 part 一律折成 `'［图片］'`，于是气泡里就只剩这三个字。
取回字节要靠 **`session/attachment({sessionId, attachment: ImageAttachmentRef})` → `{attachment, data(base64)}`**。

**修法**：`user/message` 的 item 保留原始 `parts`；气泡按 part 渲染——文本走 markdown、
图片走 `session/attachment` 拉字节（`attachCache` 按 attachmentId 缓存，重绘不重复拉）、点开全屏查看、
文件显示名字与大小。`blocksText` 仍保留 `［图片］`，但它只用于复制/搜索摘要，不再用于气泡正文。

### 忙时排队：服务端本来就有，缺的是界面（2026-11-11 补上）

- `session/prompt` 的 `mode` 是 `'queue' | 'steer'`，本端一直用 `queue`；实测（`tools/probe-image-queue2.mjs`）
  在一轮正在跑时发第二条，`session/state.queue` 立刻多出一条 `placement: 'queued'` —— **服务端排队是生效的**。
- 但客户端从不读 `session/state`，所以用户看不到自己发的消息去哪了。现在：
  - 发送后若原本 `running`，toast 提示「已排队，本轮结束后自动发送」；
  - 输入框上方新增队列条：`排队中 · N 条` + 「本轮结束后自动发送」，逐条显示内容，
    `placement: 'steering'` 的标「插话」；每条可「移除」（`session/updateQueue {action:{kind:'remove'}}`）；
  - 队列非空时每 2.5s 刷新一次，空了自动停表并收起；打开会话即拉一次。
- `QueueAction` 另有 `edit`（纯文本替换）与 `steer`（改成插话），暂未接（界面先只做「看到了 + 能撤回」）。

**测试接缝**：为了不依赖"恰好有一轮在跑"这种时序，给 `rpc` 加了 `rpcOverride`（返回 `undefined` 时走真实传输），
测试用 `__DSHM__.setRpc()` 注入假 `session/state`。**注意**：桩 `window.__DSHM__.rpc` 是**无效**的，
应用内部用的是自己的 `rpc` 绑定——这一点在模型菜单那次已经踩过，现在有了正式接缝。

### 附件的排版：它是内容，不是元信息（2026-11-10 修正）

用户反馈两件事：附件挤在 chip 行里**横向溢出**，且**长文件名时看不到删除按钮**。

根因：附件曾被渲染成 `.chip`（和「模型 / 权限 / 已连接」同一行），而 `.chips` 是 `overflow-x: auto` 的横向滚动容器、
`.chip` 又有 `max-width: 62vw` —— 名字一长，chip 撑到上限，删除标记被挤到滚动区外（要横向滑才看得到）。

改法（`renderAttachments()` + `.attachbar`）：

- 附件**单独一行**放在 chip 行与输入框之间，空列表时整行 `hidden`。
- 每条是一整行 `.attachitem`：缩略图/图标 + 名字 + 大小与状态 + 删除按钮。
- 名字用**中段省略**（`midEllipsis`，保留头尾各 15 字）——只做尾部 CSS 省略会把扩展名吃掉，
  实测 `this-is-a-delib…g-20261110.txt` 仍能看出是 .txt。
- `.attachx` 是 `flex: 0 0 auto` 的 30×30 按钮，**永不收缩**，名字再长也只能被截断，不会把按钮推出屏幕。
- 最多 152px 高、超出内部滚动；图片附件用 base64 直接渲染 30×30 缩略图。

**断言（`harness-upload`，14 项）**：附件不在 `.chips` 内、长名出现 `…` 且以 `.txt` 结尾、
✕ 的右边界在视口内（实测中心 x=380 / 视口 412）且点按面积 ≥24×24、
`.composer` 与 `.attachbar` 的 `scrollWidth <= clientWidth`（无横向溢出）、
删空后整行自动收起。

### 附件上传：手机端到底能不能用（2026-11-10 查证并补全）

**查证结论（改前）**：网页层其实一直有图片附件（`+ → input[type=file] → base64 → session/prompt`），
但**壳层是裸的 `new WebChromeClient()`，没有实现 `onShowFileChooser`** —— Android WebView 对
`<input type="file">` 的点击会**静默丢弃**，所以手机上点"+"毫无反应，等于没做。另外 `accept` 只有
`image/*`，普通文件（pdf/txt/zip…）完全没有入口。

**0.2.2 的协议（照 `dsh-api-session-controller/types/types.d.ts` 的 `PromptContentPart`）**：

```
| { type: 'text';  text: string }
| { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
| { type: 'file';  receiptId: Branded<'file-upload-receipt-id'> }
```

- 图片：**内联 base64 仍然被接受**（实测 ACCEPTED），不需要先上传。
- 文件：必须先 `POST /api/session/uploadFileBinary?sessionId=…&name=…`（`content-type: application/octet-stream`，
  body 是原始字节，**不带 mediaType 就是普通文件**），拿到 `{receiptId, file:{attachmentId,name,bytes}}`，
  再把 `{type:'file', receiptId}` 放进 prompt。实测 `session/prompt` **ACCEPTED**。
  带 `mediaType` 时该路由会把 body 当图片并做校验（坏图返回 `session/attachment-invalid / INVALID_IMAGE`）。
- **receipt 是会话级的**：换会话必须清空待发附件，否则会带着上一个会话的 receipt 发出去。

**实现**：壳层 `onShowFileChooser` + `onActivityResult`（必须回填 `ValueCallback`，否则输入框永久卡住）；
网页层 `accept="*/*"`，图片走内联、其它文件走上传拿 receipt，chip 显示文件名与"上传中"转圈，
上传未完成时拒绝发送并提示；`openSession` 切换会话清空 pending。

**验证**：`test/harness-upload.mjs` 9 项（一次性会话，真实上传、断言 prompt 组装形状、不真发消息）；
`tools/probe-upload-send.mjs` 做了一次真实投递，`session/prompt` 接受 file part。

### 抽屉分组依据：工作区归属，不是 `cwd`（2026-11-10 修正）

用户问「scratch 不是我的工作目录吧，是未分组的意思吗」——查证结果：

- `scratch` **是真实目录**：`D:/Users/Administrator/Documents/deepseek-harness/work/dsh-mobile-lite/scratch`，
  是测试跑出来的临时 cwd，**不是**工作区（`workspace/follow` 里 5 个工作区是
  `default-workspace / work / github / learn / Wechat`，没有 scratch）。
- 它原来显示成一个独立分组，是因为抽屉**按会话的 `cwd` 分组**；而桌面端是按**工作区成员关系**
  （`workspace.sessionIds`，判据是 `fs.realpath(会话 cwd) === 工作区 path`）分组的。
- 已改成与桌面一致：先用 `ws.items[].sessionIds` 建 `sessionId → workspaceId` 映射，工作区分组按注册顺序排列，
  没有归属的会话统一进「未分组」，并且**未分组的行会显示所在目录名**，避免再次把临时目录误认为工作区。
- 折叠状态改按 `workspaceId` 记忆（原来是 cwd），工作区改名不会丢折叠状态。
- `tools/where-sessions.mjs`（只读）可随时列出「会话 cwd ↔ 是否登记为工作区」；`tools/cleanup-scratch.mjs`
  只归档 **cwd 以 \scratch 结尾且 blank** 的会话，默认干跑、`--apply` 才写。

### 模型菜单「只能选、不能退」（2026-11-10 修复）

`pickModel` 当初是手搓的浮层：只给 `[data-p]` 模型行绑了点击，**没有外部点击、没有 Esc、没有取消项**，
点开之后唯一出路就是选中某个模型（`pickPermission` 反而有外部点击）。已抽成统一的 `chipMenu()`：

- 外部点击关闭（**capture 阶段**监听，且忽略触发它的那个 chip —— 否则芯片自己的 click 与 document 的监听打架，
  实测会「点了 chip 反而关不掉」）；
- `Escape` 关闭；
- 底部显式「取消」行；
- 同一个 chip 再点一次 = 开/关切换；
- 底部 `sheet()` 也补上了「点把手关闭 + Esc 关闭」。

### ⚠️ 测试绝不能改动真实会话（血的教训）

`harness-menus.mjs` 早期版本为了验证「选中模型后菜单关闭并切换成功」，**真的点了模型行**，
而它跑在「列表里第一个会话」上 —— 那正是用户正在用的会话。结果**每跑一次测试就把用户的模型切一次**，
表现为任务跑到一半 `[model changed: …]`，运行直接失败。用户连问两次才定位到。

现在的硬性约束：

1. 需要在真实 RPC 上验证的行为（如切模型）只在**一次性会话**里做，做完立刻归档；
2. 测试开头记录目标会话的模型与 `model/selection` 条数，结尾断言未被改动；
3. 断言「UI 契约」而不是「服务端副作用」：菜单行的 `data-p`/`data-m`、点击后菜单关闭等，都不需要真的写服务端；
4. 挑会话要**显式**（`--session <id>`）或按「回合数最多」挑真实对话，绝不按列表顺序摸黑；
5. 等投影（`state.cur.loaded` + `projections`）再操作，别用固定 `sleep` —— chip 在快照到达前根本不存在。

### 踩过的坑（都值得保留）

1. **明文 HTTP 下没有 `crypto.randomUUID`**（secure context 限制），需自备 polyfill；`crypto.getRandomValues` 可用。
2. **`.log` 是 flex 列容器**：不给 `flex: 0 0 auto` 会把大量消息/工具卡压成细条。
3. **`tool/result` 的字段在 `data.message` 里**（`toolCallId` / `content` / `isError`），不在 `data` 顶层。
4. **`workspaceFiles/list` 的根路径必须传 `'.'`**（空串报 `path is required`），子项要用**绝对路径**（相对名报 `no entry at "..."`）。
5. **登录前建立的 WebSocket 会被 403**，登录成功后必须重建 mux 并重新订阅 `$events`。
6. **会话快照到达后要重绘输入区**，否则模型/权限 chip 不出现。
7. `renderFiles` 与 `loadDir` 写成互相调用会爆栈——必须单向：渲染发现未加载才触发加载。
8. **明文 http 下 `navigator.clipboard` 根本不存在**（0.2.2 升级后才发现「复制」一直是坏的：点了只弹文本、没进剪贴板）。修法：优先走原生桥 `window.DSHMAndroid.copy()`（MainActivity 里用 ClipboardManager），再退 `navigator.clipboard`、再退 `document.execCommand('copy')`。
9. 本机 `github.com:443` 不通，推送走 `.github`/`work` 里的 Git Data API 脚本；`dl.google.com`、Maven Central 可达（CI 在 ubuntu runner 上编译，本机不装 Android SDK）。

## 离线出包（不依赖 GitHub Actions）

```
pwsh -File tools/build-local.ps1      # -> dist/dsh-mobile.apk
```

2026-11-10 GitHub Actions 整站故障（`Actions major_outage`，run 零 job 直接 failure）时打通的一条
**无 SDK、无 Gradle、无 AGP** 的本地产线，只用已经在机器上的 build-tools + 一个 `android.jar`：

- 需要的物料：`tools/buildtools/android-14/`（aapt2 / zipalign / apksigner，136.6 MB，本来就有）、
  `tools/platform/android-34-ext12/android.jar`（25 MB，从 `platform-34-ext12_r01.zip` 里单抽）、
  `tools/platform/android-16/lib/d8.jar`（build-tools 36.1 的 d8）、JDK（本机 25）、仓库里的 `keystore.jks`。
  合计新增磁盘 **约 25 MB**（build-tools 36.1 只抽 d8.jar 约 17 MB）。
- 流程：`aapt2 compile` → `aapt2 link -A assets --java gen` → `javac -source 17 -target 17 -classpath android.jar`
  → `java -cp d8.jar com.android.tools.r8.D8` → 规范化 zip 条目名 → `jar uf` 塞 classes.dex →
  `zipalign -f 4` → `apksigner sign`（同一 keystore，可与 CI 包互相覆盖安装）。

**三个必踩的坑（都已写进脚本）**：

1. **AGP 会注入 manifest 的 `package` 属性**，裸 aapt2 必须自己补，否则报 `<manifest> must have a 'package' attribute`；
   脚本把带 package 的副本写到 `build/manual/AndroidManifest.xml`，不动源文件。
2. **build-tools 34 的 d8（R8 8.2.2）读不了 JDK 25 javac 的产物**，任何内部类都会 NPE
   （`Cannot invoke "String.length()" because "<parameter1>" is null`），降 `-source 8/11` 都无用；
   换 build-tools **36.1** 的 d8.jar 立刻正常。用 1.8.1 的源码做过对照，确认与本项目代码无关。
3. **aapt2 在 Windows 上把 `-A` 的资源条目名写成反斜杠**（`assets/www\app.js`），Android 的 AssetManager
   用正斜杠找不到 → 装上白屏。`tools/fix-zip-names.ps1` 重写 zip 条目名，并保持
   **`resources.arsc` 不压缩**（targetSdk ≥ 30 的硬要求，压缩了装不上）。

产物自检：`verify-apk` 14 个条目齐全、v2+v3 签名、assets 与仓库源文件 **sha256 逐一相同**、dex magic `dex\n038`。

## 测试台

```
test/harness.mjs      列表/对话/发送/截图（--login 测登录流程）
test/harness-ask.mjs  让 agent 调 ask_user_question，验证卡片与回执
test/harness-perm.mjs 权限预设切换（UI 与宿主投影双向核对）
test/harness-b.mjs    搜索/选目录/命令面板/长按消息
test/harness-c2.mjs   文件浏览与预览/任务/目标
test/harness-traj.mjs 轨迹面板
test/harness-info.mjs 会话信息面板
test/probe-term.mjs   终端协议裸探针（一元 + 流，逐帧打印）
test/harness-term.mjs 终端面板：连接/输入/键盘/尺寸/重开复用/主题，10 项断言
test/probe-sched-ws.mjs    定时任务/工作区协议探针（含 request 包装验证）
test/harness-sched-ws.mjs  定时任务 + 工作区：15 项断言（--skip-agent 跳过让模型建任务的慢路径）
test/cleanup-harness-sessions.mjs 归档测试里新建的临时会话
test/probe-settings.mjs / probe-settings-write.mjs / probe-settings-shape.mjs  设置读写语义探针
test/harness-settings.mjs  设置可写 + 插件 + 技能：12 项断言（含真实写入与精确还原）
test/probe-022.mjs         0.2.2 协议探针（terminal/attach 双向 + schedule 新结构）
test/harness-sched22.mjs   定时任务 0.2.2：列表/表单新建/暂停/恢复/删除，9 项断言
test/harness-ui.mjs        桌面化 UI：抽屉/切换/搜索/去气泡/回到底部/代码复制/返回键，12 项断言
test/harness-login.mjs     登录页稳定性：不重建/不丢输入/能登录，5 项断言
test/harness-menus.mjs     模型/权限浮层可退出 + 抽屉折叠 + 空会话折叠，15 项断言（含"不得改动人类会话"守卫）
test/harness-upload.mjs    附件：任意类型选择、文件上传拿 receipt、图片内联、prompt 组装、换会话清空、布局，14 项断言
test/harness-attachments.mjs 发出的图片真渲染 + 全屏查看 + 队列条显示/移除，6 项断言
test/harness-typing.mjs    跑动中打字不被清空/焦点不丢（含真实多步回合），5 项断言
test/harness-lineage.mjs   子代理缩进挂父会话、分叉仍并列、父会话提示，7 项断言
tools/model-state.mjs      打印某会话的当前模型与 model/selection 条数，用于前后对照
tools/restore-model.mjs    把会话模型显式恢复为 provider/model
tools/refresh-state.mjs    升级后重抓登录 cookie（recon/traffic.storage.json）
test/measure.mjs      冷/热启动首帧耗时
```

测试台原理：Playwright `page.route` 拦截 `http://<server>/__app/**` 回本地 `assets/www`，
与 App 内 `shouldInterceptRequest` 等价；页面 origin 仍是 DSH 源站，所以 cookie/fetch/WS 全同源。
