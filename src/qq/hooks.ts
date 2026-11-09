import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  LOOPBACK_HOST,
  removeEndpointFile,
  writeEndpointFile,
  type EndpointInfo,
} from './endpoint.ts';
import {
  isCodeCommandText,
  stripMentionSeparators,
} from '../code-tasks/parser.ts';
import { ReceiptStoreError } from './receipts.ts';
import type { SessionMap } from './session-map.ts';
import type { Receipt, ReceiptStore } from './types.ts';
import { parseHookEvent, type HookEvent } from './wire.ts';

export const MAX_HOOK_BODY_BYTES = 64 * 1024;
export const HEALTH_VERSION = '0.2.0';

export interface ReservedHookEvent {
  event: HookEvent;
  sessionKey: string;
  receipt: Receipt;
}

export interface HookServerOptions {
  port: number;
  token: string;
  runtimeDir: string;
  receipts: ReceiptStore & { readonly count?: number };
  sessionMap: SessionMap;
  /** 只允许缺省或字面量 127.0.0.1。 */
  host?: string;
  now?: () => number;
  onWarn?: (message: string) => void;
  instanceId?: string;
  pid?: number;
  /** 仅新 Receipt 成功后回调（T6 用于入队）；重复/忽略不会触发。 */
  onReserved?: (reserved: ReservedHookEvent) => void;
  /**
   * `code` 控制消息回调。触发时绝不会 reserve L0/Receipt、入队或调用模型；
   * deny（403）优先，回调异常只走安全日志。
   */
  onCodeCommand?: (event: HookEvent) => void;
  /** `/status` 的固定计数来源；抛错时只返回 500 {ok:false}。 */
  statusProvider?: () => Record<string, unknown>;
}

class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

function tokenMatches(expected: string, provided: string | string[] | undefined): boolean {
  if (typeof provided !== 'string') return false;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const providedBuffer = Buffer.from(provided, 'utf8');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_HOOK_BODY_BYTES) {
    req.resume();
    return Promise.reject(new BodyTooLargeError());
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_HOOK_BODY_BYTES) {
        finish(() => reject(new BodyTooLargeError()));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (err) => finish(() => reject(err)));
    req.on('aborted', () => finish(() => reject(new Error('请求已中断'))));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function listenOnce(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      server.off('error', onError);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

function boundPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('hook 未取得绑定端口');
  }
  return address.port;
}

async function listenWithFallback(
  server: Server,
  preferredPort: number,
  onWarn: (message: string) => void,
): Promise<number> {
  try {
    await listenOnce(server, preferredPort);
    return boundPort(server);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (preferredPort !== 0 && (code === 'EADDRINUSE' || code === 'EACCES')) {
      onWarn(`hook 端口 ${preferredPort} 绑定失败（${code ?? 'unknown'}），回退到系统分配端口`);
      await listenOnce(server, 0);
      return boundPort(server);
    }
    throw err;
  }
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * 脑侧 hook 服务（T2）：只监听字面量 127.0.0.1。
 *
 * 顺序固定：token(401) → 形状(400) → 权限 deny(403) → code 控制面短路
 * → 静默 → reserve → 200/503。
 */
export class HookServer {
  private readonly options: HookServerOptions;
  private readonly onWarn: (message: string) => void;
  private readonly now: () => number;
  private readonly instanceId: string;
  private readonly pid: number;

  private server: Server | null = null;
  private endpoint: EndpointInfo | null = null;
  private readonly startedAt: number;

  constructor(options: HookServerOptions) {
    if (options.host !== undefined && options.host !== LOOPBACK_HOST) {
      throw new Error('hook 只允许绑定字面量 127.0.0.1');
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error('hookPort 非法');
    }

    this.options = options;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
    this.now = options.now ?? Date.now;
    this.instanceId = options.instanceId ?? randomUUID();
    this.pid = options.pid ?? process.pid;
    this.startedAt = this.now();
  }

  get port(): number {
    return this.endpoint?.port ?? 0;
  }

  async start(): Promise<EndpointInfo> {
    if (this.endpoint) return this.endpoint;

    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    this.server = server;

    let port: number;
    try {
      port = await listenWithFallback(server, this.options.port, this.onWarn);
    } catch (err) {
      this.server = null;
      throw err;
    }

    const endpoint: EndpointInfo = {
      v: 1,
      name: 'ds-memory',
      host: LOOPBACK_HOST,
      port,
      pid: this.pid,
      startedAt: this.now(),
      instanceId: this.instanceId,
    };

    try {
      writeEndpointFile(this.options.runtimeDir, endpoint);
    } catch (err) {
      await closeServer(server);
      this.server = null;
      throw err;
    }

    this.endpoint = endpoint;
    return endpoint;
  }

  async stop(): Promise<void> {
    const server = this.server;
    const endpoint = this.endpoint;
    this.server = null;
    this.endpoint = null;

    if (server) await closeServer(server);
    if (endpoint) {
      removeEndpointFile(this.options.runtimeDir, endpoint.name, endpoint.instanceId);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      sendJson(res, 400, { ok: false });
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, {
        name: 'ds-memory',
        version: HEALTH_VERSION,
        ok: true,
        hookPort: this.endpoint?.port ?? 0,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/status') {
      this.handleStatus(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/hook/message') {
      await this.handleHook(req, res);
      return;
    }

    sendJson(res, 404, { ok: false });
  }

  private handleStatus(req: IncomingMessage, res: ServerResponse): void {
    if (!tokenMatches(this.options.token, req.headers['x-memory-token'])) {
      sendJson(res, 401, { ok: false });
      return;
    }

    try {
      const provider = this.options.statusProvider?.() ?? {};
      const receipts = this.options.receipts.count ?? 0;
      const body: Record<string, unknown> = {
        ok: true,
        pid: this.pid,
        uptimeMs: Math.max(0, this.now() - this.startedAt),
        hookPort: this.endpoint?.port ?? 0,
        gateway: 'unknown',
        sessions: this.options.sessionMap.count,
        receipts,
        inbox: { pending: 0, busy: 0 },
        recovered: 0,
        aborted: 0,
        ...provider,
      };
      body.ok = true;
      sendJson(res, 200, body);
    } catch {
      this.onWarn('status provider 失败');
      sendJson(res, 500, { ok: false });
    }
  }

  private async handleHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokenMatches(this.options.token, req.headers['x-memory-token'])) {
      sendJson(res, 401, { ok: false });
      return;
    }

    let bodyText: string;
    try {
      bodyText = await readRequestBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { ok: false });
        return;
      }
      sendJson(res, 400, { ok: false });
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { ok: false });
      return;
    }

    const event = parseHookEvent(json);
    if (!event) {
      sendJson(res, 400, { ok: false });
      return;
    }

    const decision = this.options.sessionMap.classify(event.source, event.sender.qqId, {
      isAtBot: event.isAtBot,
    });
    if (decision.action === 'deny') {
      this.onWarn(`hook 权限拒绝：${decision.reason}`);
      sendJson(res, 403, { ok: false });
      return;
    }
    const codeCandidate =
      event.source.kind === 'group' && event.isAtBot
        ? stripMentionSeparators(event.text)
        : event.text;
    if (isCodeCommandText(codeCandidate)) {
      try {
        this.options.onCodeCommand?.(event);
      } catch {
        this.onWarn('code 命令回调失败');
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    if (decision.action === 'ignore' || decision.sessionKey === null) {
      sendJson(res, 200, { ok: true });
      return;
    }

    let reserved;
    try {
      reserved = this.options.receipts.reserve({
        eventId: event.eventId,
        sessionKey: decision.sessionKey,
        role: 'user',
        text: event.text,
        speaker: event.source.kind === 'group' ? event.sender.nickname : null,
        quote: event.quote
          ? { fromName: event.quote.fromName, text: event.quote.text }
          : null,
        isAtBot: event.isAtBot,
        senderQqId: event.sender.qqId,
        modelEligible: decision.modelEligible,
        at: event.at,
      });
    } catch (err) {
      if (err instanceof ReceiptStoreError) {
        this.onWarn(`hook 持久化失败：${err.code}`);
      } else {
        this.onWarn('hook 持久化失败');
      }
      sendJson(res, 503, { ok: false });
      return;
    }

    if (reserved.kind === 'new') {
      this.options.sessionMap.record(event.source, event.at, event.sender.qqId);
      if (!decision.modelEligible) {
        try {
          if (!this.options.receipts.markStoredOnly(reserved.receipt.eventId)) {
            this.onWarn('Receipt stored_only 状态迁移失败');
          }
        } catch {
          this.onWarn('Receipt stored_only 状态迁移失败');
        }
      } else if (this.options.onReserved) {
        try {
          this.options.onReserved({
            event,
            sessionKey: decision.sessionKey,
            receipt: reserved.receipt,
          });
        } catch {
          this.onWarn('hook 入队回调失败');
        }
      }
    }

    sendJson(res, 200, { ok: true });
  }
}
