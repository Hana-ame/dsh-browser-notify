# dsh-browser-notify

DSH 完成一个会话回应、或 agent 弹出选择题（`ask_user_question`）时，由**你的浏览器**（访问 3080 的那个）用 Web Notification API 弹桌面通知，点击跳回 DSH 页面。

纯 client 插件：**不依赖 PowerShell、不依赖任何系统级通知后端**。通知从你已打开的浏览器发出，所以天然只在你能看到的地方弹。

## 触发点

| 投影 | 触发 | 说明 |
|---|---|---|
| `turnOutline` 新增 turn | 「回应完成」 | 主会话每完成一次回应。页面加载时已存在的历史 turn 不弹（按 turn 计数增量判定）。 |
| `userQuestions` 出现 active | 「需要你回答」 | agent 提了 `ask_user_question`（选择题/需确认）。 |

- 页面隐藏（`document.hidden === true`）时才弹，避免盯着页面时刷屏。
- 同会话同内容重复渲染不重复弹（按 turn 计数 / question key 去抖）。

## 点击跳转

`notification.onclick` → `window.focus()` + 跳到 `launchUrl`（默认 `http://127.0.0.1:3080`）。Chrome 对同 origin 通知会聚焦已打开的 DSH tab。

## 权限

首次需要授权桌面通知：右下角状态条显示「通知 · 未授权」时点它授权（调 `Notification.requestPermission()`）。授权一次后浏览器记住。未授权时插件静默不发，不刷权限弹框。

## 开关

右下角「通知 · 开 / 关」状态条一键开关，存 `localStorage`（`dsh.browser-notify.enabled`，默认开）。跳转地址存 `dsh.browser-notify.launchUrl`。

## 布局

```
index.js           Host 半：空壳（无 Host 服务可注册）
client.js          Client 半：订阅会话投影 → Web Notification
cordis.patch.yml   bundle patch
package.json
```

`package.json` 的 `dsh.client.platform = "web"` 让 DSH 把它作为客户端插件加载；不写死任何宿主代码补丁，升级 DSH 不失效。

## 测试

```bash
npm test   # 7 项：纯逻辑（新增 turn 弹、历史 seed 不弹、点击跳转、权限/开关门控、去抖），假 Notification 不花钱
```
