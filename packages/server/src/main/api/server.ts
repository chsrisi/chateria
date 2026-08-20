import { createServer, type Server as HttpServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import type { ApiConfig } from './config.ts';
import { createPool, migrate, serverVersion, waitForDatabase, type Pool } from './db.ts';
import { loadOrCreateKeys, rotateKeys, type SigningKeys } from './keys.ts';
import { createHub, type ConnectedUser, type Hub } from './realtime.ts';
import { createRouter } from './routes.ts';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSink = (level: LogLevel, message: string) => void;

export interface ApiStats {
  status: 'stopped' | 'starting' | 'running' | 'error';
  port: number | null;
  sockets: number;
  connectedUsers: ConnectedUser[];
  databaseVersion: string | null;
  keyId: string | null;
  error: string | null;
}

export interface ApiRuntime {
  start(config: ApiConfig): Promise<ApiStats>;
  stop(): Promise<ApiStats>;
  stats(): ApiStats;
  /**
   * Mint a fresh ES256 pair. Every previously issued token stops verifying, so
   * a running server is restarted to pick the new key up.
   */
  rotate(): Promise<string>;
}

/**
 * Wraps the whole backend in something the Electron main process can start,
 * stop, and inspect. Nothing here touches Electron APIs, so the same module is
 * what the integration test drives headlessly.
 */
export function createApiRuntime(keyDirectory: string, log: LogSink): ApiRuntime {
  let httpServer: HttpServer | null = null;
  let pool: Pool | null = null;
  let hub: Hub | null = null;
  let keys: SigningKeys | null = null;
  let databaseVersion: string | null = null;
  let port: number | null = null;
  let status: ApiStats['status'] = 'stopped';
  let lastError: string | null = null;
  /** Remembered so rotate() can bring the server back up on the same settings. */
  let activeConfig: ApiConfig | null = null;

  function stats(): ApiStats {
    return {
      status,
      port,
      sockets: hub?.socketCount() ?? 0,
      connectedUsers: hub?.connectedUsers() ?? [],
      databaseVersion,
      keyId: keys?.kid ?? null,
      error: lastError,
    };
  }

  async function teardown(): Promise<void> {
    await hub?.close().catch(() => {});
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    await pool?.end().catch(() => {});
    httpServer = null;
    hub = null;
    pool = null;
    port = null;
    databaseVersion = null;
  }

  const runtime: ApiRuntime = {
    stats,

    async start(config) {
      if (status === 'running' || status === 'starting') return stats();
      status = 'starting';
      lastError = null;
      activeConfig = config;

      try {
        keys ??= await loadOrCreateKeys(keyDirectory);
        log('info', `Signing key ready (ES256, kid ${keys.kid.slice(0, 12)}...)`);

        pool = createPool(config.databaseUrl);
        log('info', 'Connecting to PostgreSQL...');
        await waitForDatabase(pool, { attempts: 15, delayMs: 500 });
        databaseVersion = await serverVersion(pool);
        log('info', `Connected to PostgreSQL ${databaseVersion}`);

        await migrate(pool);
        log('info', 'Schema up to date');

        hub = createHub({
          pool,
          keys,
          maxMessageLength: config.maxMessageLength,
          onLog: log,
        });

        const app = express();
        app.disable('x-powered-by');
        app.use(cors());
        app.use(express.json({ limit: '64kb' }));

        app.get('/health', (_req, res) => {
          res.json({ status: 'ok', uptime: process.uptime() });
        });

        // Public key material, so a client can verify tokens offline if it wants.
        app.get('/.well-known/jwks.json', (_req, res) => {
          res.json({ keys: keys ? [keys.publicJwk] : [] });
        });

        app.use('/api', createRouter({ pool, keys, hub, config }));
        app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

        app.use(
          (
            error: unknown,
            _req: express.Request,
            res: express.Response,
            _next: express.NextFunction,
          ) => {
            const typed = error as { type?: string; status?: number };
            if (typed?.type === 'entity.too.large') {
              return res.status(413).json({ error: 'Request body too large' });
            }
            if (error instanceof SyntaxError && typed.status === 400) {
              return res.status(400).json({ error: 'Malformed JSON' });
            }
            log('error', `Unhandled request error: ${String(error)}`);
            return res.status(500).json({ error: 'Internal server error' });
          },
        );

        httpServer = createServer(app);
        httpServer.on('upgrade', (request, socket, head) => {
          hub!.handleUpgrade(request, socket, head);
        });

        await new Promise<void>((resolve, reject) => {
          httpServer!.once('error', reject);
          httpServer!.listen(config.port, '0.0.0.0', () => {
            httpServer!.removeListener('error', reject);
            resolve();
          });
        });

        port = config.port;
        status = 'running';
        log('info', `API listening on port ${config.port}`);
        return stats();
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        log('error', `Start failed: ${lastError}`);
        await teardown();
        status = 'error';
        return stats();
      }
    },

    async stop() {
      if (status === 'stopped') return stats();
      await teardown();
      status = 'stopped';
      lastError = null;
      log('info', 'API stopped');
      return stats();
    },

    async rotate() {
      // The router and hub captured the previous key object, so a live server
      // has to be cycled or it would keep verifying against the old public key.
      const wasRunning = status === 'running';
      const config = activeConfig;
      if (wasRunning) await runtime.stop();

      keys = await rotateKeys(keyDirectory);
      log('warn', `Signing key rotated to ${keys.kid.slice(0, 12)}... - all tokens revoked`);

      if (wasRunning && config) await runtime.start(config);
      return keys.kid;
    },
  };

  return runtime;
}
