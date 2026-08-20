/** Runtime configuration for the API, supplied by the desktop shell. */
export interface ApiConfig {
  databaseUrl: string;
  port: number;
  maxMessageLength: number;
  /** jose-compatible lifetime, e.g. "7d" or "12h". */
  tokenTtl: string;
}

export const DEFAULT_CONFIG: ApiConfig = {
  databaseUrl:
    process.env.CHATERIA_DATABASE_URL ??
    'postgres://chateria:chateria@127.0.0.1:5432/chateria',
  port: Number.parseInt(process.env.CHATERIA_API_PORT ?? '3000', 10),
  maxMessageLength: Number.parseInt(process.env.CHATERIA_MAX_MESSAGE_LENGTH ?? '4000', 10),
  tokenTtl: process.env.CHATERIA_TOKEN_TTL ?? '7d',
};

/** Seconds represented by a jose duration string, for AuthResult.expiresIn. */
export function ttlToSeconds(ttl: string): number {
  const match = /^(\d+)\s*(s|m|h|d|w)?$/.exec(ttl.trim());
  if (!match) return 7 * 24 * 60 * 60;
  const value = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit] ?? 1;
  return value * multiplier;
}
