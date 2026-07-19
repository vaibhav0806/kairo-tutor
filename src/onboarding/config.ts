// The Kairo backend base URL (mirror of src-tauri/src/constants.rs KAIRO_BACKEND_URL).
export const KAIRO_BACKEND_URL = 'http://localhost:8787';

export const hasNativeBridge = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
