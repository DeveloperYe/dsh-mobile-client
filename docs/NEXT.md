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
| 1.6.0 | **终端**：xterm 6.0.0（与宿主同版本，从 GUI 包里抽出内置）+ `terminal/*` 全套；多 shell、键栏、自适应尺寸、重开复用同一进程、明暗跟随 |

## 剩余工作

1. ~~终端面板~~ ✅ 1.6.0 完成
2. **定时任务**（`schedule/list` 的请求体形状未确认）
3. **工作区管理**（改名/归档/置顶；`WorkspaceRenameRequest` 等字段未确认）
4. **设置写操作**（改凭据 `credentials/set`、`settings/mutate`、插件开关）
5. UI 细活：长按会话出操作菜单、面板转场动效

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

### 踩过的坑（都值得保留）

1. **明文 HTTP 下没有 `crypto.randomUUID`**（secure context 限制），需自备 polyfill；`crypto.getRandomValues` 可用。
2. **`.log` 是 flex 列容器**：不给 `flex: 0 0 auto` 会把大量消息/工具卡压成细条。
3. **`tool/result` 的字段在 `data.message` 里**（`toolCallId` / `content` / `isError`），不在 `data` 顶层。
4. **`workspaceFiles/list` 的根路径必须传 `'.'`**（空串报 `path is required`），子项要用**绝对路径**（相对名报 `no entry at "..."`）。
5. **登录前建立的 WebSocket 会被 403**，登录成功后必须重建 mux 并重新订阅 `$events`。
6. **会话快照到达后要重绘输入区**，否则模型/权限 chip 不出现。
7. `renderFiles` 与 `loadDir` 写成互相调用会爆栈——必须单向：渲染发现未加载才触发加载。
8. 本机 `github.com:443` 不通，推送走 `.github`/`work` 里的 Git Data API 脚本；`dl.google.com`、Maven Central 可达（CI 在 ubuntu runner 上编译，本机不装 Android SDK）。

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
test/measure.mjs      冷/热启动首帧耗时
```

测试台原理：Playwright `page.route` 拦截 `http://<server>/__app/**` 回本地 `assets/www`，
与 App 内 `shouldInterceptRequest` 等价；页面 origin 仍是 DSH 源站，所以 cookie/fetch/WS 全同源。
