import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "@team-knowledge/auth-client-web";
import { App } from "./App";
import { I18nProvider } from "./i18n";
import { installLangHeader } from "./i18n/lang";
import { API_BASE } from "./lib/api";
import "./index.css";

// 登录可选。不设置 → 本地单用户模式。反向代理把同源 /auth/* 转给 feishu-sso 时，
// 设置 VITE_SSO_BASE=/auth（写在 web/.env.local 或构建时注入），api 也要同时设置 WHOAMI_URL。
// 发往本站 api 的请求统一带 X-Lang，服务端按它返回对应语言的提示与 AI 回答。
installLangHeader(API_BASE);

const ssoBase = (import.meta.env.VITE_SSO_BASE as string | undefined) || undefined;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <AuthProvider config={{ ssoBase }}>
        <App />
      </AuthProvider>
    </I18nProvider>
  </React.StrictMode>
);
