// feishu-sso 登录入口的唯一真值源：基址、登录/退出地址和跳转都从这里取。
// 基址由构建变量 VITE_SSO_BASE 决定（反向代理把同源 /auth/* 转给 feishu-sso），默认 /auth。
//
// return_to 约定（feishu-sso README「return_to 约定」）：传「与当前页面同源的绝对 URL」即可，
// 也就是 window.location.href；feishu-sso 按反代的 X-Forwarded-Proto / Host 校验同源，
// 不需要配置 ALLOWED_RETURN_TO。
export const SSO_BASE = ((import.meta.env.VITE_SSO_BASE as string | undefined) ?? "/auth").replace(/\/$/, "");

export const ssoLoginUrl = () => `${SSO_BASE}/login`;
export const ssoLogoutApiUrl = () => `${SSO_BASE}/api/logout`;

/** 把浏览器送到 SSO 登录页，登录后回到当前地址。已经在登录页上时不重复跳转，避免循环。 */
export function redirectToSsoLogin(): void {
  const loginUrl = ssoLoginUrl();
  if (window.location.href.startsWith(new URL(loginUrl, window.location.origin).toString())) return;
  window.location.assign(`${loginUrl}?return_to=${encodeURIComponent(window.location.href)}`);
}
