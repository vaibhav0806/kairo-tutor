import { Agent } from 'undici';

// Keep-alive pool to provider hosts (mirrors the desktop's reqwest warm pool) so the first ask
// after a lull skips the cold TLS handshake.
export const agent = new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, connections: 32 });
