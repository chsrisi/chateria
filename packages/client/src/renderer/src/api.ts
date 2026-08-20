import type {
  AuthResult,
  Credentials,
  DmSummary,
  MessagePage,
  PresenceEntry,
  PublicUser,
  RoomSummary,
  ServerInfo,
} from '@chateria/protocol';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
  /** True when the server rejected our identity and we should sign out. */
  get isAuthFailure(): boolean {
    return this.status === 401;
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  { token, method = 'GET', body }: { token?: string; method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server');
  }

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? `Request failed (${response.status})`);
  }
  return payload as T;
}

/** Thin typed wrapper; every call is bound to one server URL and token. */
export function createApi(baseUrl: string, token?: string) {
  const auth = token ? { token } : {};
  return {
    info: () => request<ServerInfo>(baseUrl, '/info'),
    register: (credentials: Credentials) =>
      request<AuthResult>(baseUrl, '/auth/register', { method: 'POST', body: credentials }),
    login: (credentials: Credentials) =>
      request<AuthResult>(baseUrl, '/auth/login', { method: 'POST', body: credentials }),
    me: () => request<PublicUser>(baseUrl, '/me', auth),
    rooms: () => request<RoomSummary[]>(baseUrl, '/rooms', auth),
    createRoom: (name: string) =>
      request<RoomSummary>(baseUrl, '/rooms', { ...auth, method: 'POST', body: { name } }),
    joinRoom: (roomId: number) =>
      request<void>(baseUrl, `/rooms/${roomId}/join`, { ...auth, method: 'POST' }),
    leaveRoom: (roomId: number) =>
      request<void>(baseUrl, `/rooms/${roomId}/leave`, { ...auth, method: 'POST' }),
    roomMessages: (roomId: number, before?: number | null) =>
      request<MessagePage>(
        baseUrl,
        `/rooms/${roomId}/messages${before ? `?before=${before}` : ''}`,
        auth,
      ),
    dms: () => request<DmSummary[]>(baseUrl, '/dms', auth),
    createDm: (userId: number) =>
      request<{ conversationId: number }>(baseUrl, '/dms', {
        ...auth,
        method: 'POST',
        body: { userId },
      }),
    dmMessages: (conversationId: number, before?: number | null) =>
      request<MessagePage>(
        baseUrl,
        `/dms/${conversationId}/messages${before ? `?before=${before}` : ''}`,
        auth,
      ),
    users: (q = '') =>
      request<PublicUser[]>(baseUrl, `/users?q=${encodeURIComponent(q)}`, auth),
    presence: () => request<PresenceEntry[]>(baseUrl, '/presence', auth),
  };
}

export type Api = ReturnType<typeof createApi>;
