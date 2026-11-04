import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "@team-knowledge/auth-client-web";
import { App } from "./App";
import "./index.css";

// 登录可选。不设置 → 本地单用户模式。反向代理把同源 /auth/* 转给 feishu-sso 时，
// 设置 VITE_SSO_BASE=/auth（写在 web/.env.local 或构建时注入），api 也要同时设置 WHOAMI_URL。
const ssoBase = (import.meta.env.VITE_SSO_BASE as string | undefined) || undefined;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider config={{ ssoBase }}>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
