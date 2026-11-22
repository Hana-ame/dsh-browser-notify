/**
 * dsh-browser-notify — Host 半边（空壳）。
 *
 * 本插件的所有逻辑都在 Client 半边（client.js）：订阅会话投影、在 turn 完成 /
 * ask_user_question 出现时用浏览器 Notification API 弹桌面通知。
 * Host 侧没有可注册的服务、路由或工具。
 */

export const name = 'dsh-browser-notify'

/** Host plugin body: nothing to register on the host side. */
export function apply() {}