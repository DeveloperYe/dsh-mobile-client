# DSH Mobile

一个为手机写的 **DeepSeek Harness 客户端 App**（Android，单 Activity + WebView 外壳）。

打开即用：界面资源全部打进 APK，启动不加载任何远端页面，也没有 12.5 MiB 的插件包要下。
装到手机上就是一个带图标、启动页、全屏的原生 App，直连你自己的 DSH（默认
`http://36.138.189.24:3080`）。

| | 浏览器打开 DSH | 本 App |
|---|---|---|
| 首屏资源 | ≈14.0 MiB（插件包 12.54 MiB + 主程序 1.34 MiB + CSS/HTML） | **0（全部在 APK 内）** |
| 每次打开 | 下载 + 解析执行 12.5 MiB JS | 本地解析 ~60 KB JS |
| 界面 | 桌面版 SPA 缩到手机上 | 为竖屏/触屏写的会话列表 + 对话流 |
| 注入的上下文（OpenViking/系统提示等） | 全部堆在消息流里 | 默认折叠隐藏（可在设置里打开） |

## 它是怎么工作的

* App 把 WebView 指向 `http://<服务器>/__app/index.html`，但 `/__app/**` 下的所有请求都被
  `MainActivity.shouldInterceptRequest` 用 APK 内的 `assets/www` 应答。
  → 页面 URL 仍然是 DSH 的 origin，于是 **fetch / cookie / WebSocket 全是同源**，
  不需要 CORS 变通、不需要反向代理；同时外壳又完全来自本地，不产生网络往返。
* 界面只依赖 DSH 已公开的 RPC 协议（实测于 `@deepseek-ai/dsh@0.2.0-rc.2`）：
  * 一元调用 `POST /api/<method>`，体为 `{type:'client-request', rpcId, method, payload:{args}}`
  * 流式 `WS /api/remote.mux`，`{type:'open', streamId, endpoint, payload:{args}}`
  * 登录 `POST /-/auth/login`（dsh-access-gate 密码）后跟 302 落到 DSH 的 auth cookie
  用到的端点：`session/list` `session/follow` `session/page` `session/prompt`
  `session/cancel` `session/create` `session/rename` `session/modelCatalog` `session/selectModel`。

## 功能

* 会话列表：按工作区分组、运行中标记、相对时间；缓存上次列表 → **打开瞬间就有内容**
* 对话：用户消息 / 助手输出（markdown、代码块、表格）/ **折叠的思考过程** / 工具调用卡片（参数 + 结果，失败标红）
* **逐字流式输出**（`assistant-stream` 帧：`block-start` / `text-delta` / `block-end`）
* 发消息、排队、中断（■）、切换模型、重命名、新建会话
* 发图片（base64 内联进 prompt，最多 6 MB/张）
* 注入上下文（系统提示/记忆插件/技能目录…）默认折叠；设置里可切换
* 深色/浅色主题

## 构建

CI 出包（不需要本机 Android SDK）：

```
push main  →  GitHub Actions(.github/workflows/android.yml)
           →  gradle assembleRelease（ubuntu runner，JDK 17 + Android SDK 预装）
           →  Release「latest」里的 dsh-mobile.apk
```

本地只在浏览器里开发/验证界面（见 `test/harness.mjs`：用请求拦截把同一个 `assets/www`
喂给 Chromium，等价于 App 里的 `shouldInterceptRequest`）。

## 安装

1. 手机下载 `dsh-mobile.apk`（Release 附件，或从你的服务器转发）。
2. 允许「安装未知来源应用」，装好即可。
3. 首次打开：确认服务器地址 → 填 dsh-access-gate 的访问密码 → 进入会话列表。
   密码与地址存在本机；登录 cookie 由 WebView 持久化。

## 安全

* 只跟你在设置里指定的那台 DSH 通信；`usesCleartextTraffic` 是必须的（DSH 默认是明文 HTTP）。
* `keystore.jks` 随仓库提交（口令见 `app/build.gradle.kts`），目的是让每次 CI 的 APK 用同一把钥匙签名、可以覆盖安装。
  这是个人自用旁加载 App 的取舍；若要上架请自行换掉。
