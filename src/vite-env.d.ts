/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly KAIRO_APP_ENV?: string;
  readonly KAIRO_AI_PROVIDER?: string;
  readonly KAIRO_STT_PROVIDER?: string;
  readonly KAIRO_TTS_PROVIDER?: string;
  readonly KAIRO_DEFAULT_SKILL?: string;
  readonly KAIRO_ENABLE_WEB_RESEARCH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
