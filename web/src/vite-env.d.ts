/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SSO_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
