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
tools/refresh-state.mjs    升级后重抓登录 cookie（recon/traffic.storage.json）
test/measure.mjs      冷/热启动首帧耗时
```

测试台原理：Playwright `page.route` 拦截 `http://<server>/__app/**` 回本地 `assets/www`，
与 App 内 `shouldInterceptRequest` 等价；页面 origin 仍是 DSH 源站，所以 cookie/fetch/WS 全同源。
