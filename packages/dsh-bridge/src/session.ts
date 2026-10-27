// DSH session client (F09). Talks to DSH Host over the plain /api JSON channel:
// launch token -> GET /connect -> API cookie -> POST /api/<method>.
// Protocol confirmed against the M0 probe (_sandbox/f01-dsh-desktop/scripts/probe-session.mjs)
// and DSH source (packages/client/connection, packages/api/session-controller).

import { randomUUID } from "node:crypto";
import { dshStream, type DshSocketFactory } from "./stream.ts";

/** Same call shape as the global fetch; injectable so tests run without DSH. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DshErrorKind = "connect_failed" | "http_failed" | "rpc_failed";

/**
 * connect_failed: token exchange failed (no token, bad status, or no cookie issued).
 * http_failed: /api returned a non-2xx status or an unreadable envelope.
 * rpc_failed: envelope carried result.ok === false; code/details come from DSH.
 */
export class DshRpcError extends Error {
  readonly kind: DshErrorKind;
  readonly method?: string;
  readonly http_status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    kind: DshErrorKind,
    message: string,
    extra: { method?: string; http_status?: number; code?: string; details?: unknown } = {},
  ) {
    super(message);
    this.name = "DshRpcError";
    this.kind = kind;
    this.method = extra.method;
    this.http_status = extra.http_status;
    this.code = extra.code;
    this.details = extra.details;
  }
}

interface RpcFailure {
  code: string;
  message: string;
  details?: unknown;
}

// Envelope shapes: client/connection/src/rpc.ts:80-92, rpc-schema.ts:10-31.
interface ServerResponse {
  type?: string;
  rpcId?: string;
  result?: { ok: true; value?: unknown } | { ok: false; error?: RpcFailure };
}

export interface DshClientOptions {
  /** Launch URL as printed by DSH, carrying ?token=. */
  launch_url: string;
  fetch?: FetchLike;
  socketFactory?: DshSocketFactory;
  signal?: AbortSignal;
}

/** Low-level RPC client holding the cookie issued by /connect. */
export class DshClient {
  readonly origin: string;
  private readonly cookie: string;
  private readonly fetchImpl: FetchLike;
  private readonly socketFactory?: DshSocketFactory;
  private readonly launchUrl: string;

  private constructor(origin: string, cookie: string, fetchImpl: FetchLike, launchUrl: string, socketFactory?: DshSocketFactory) {
    this.origin = origin;
    this.cookie = cookie;
    this.fetchImpl = fetchImpl;
    this.socketFactory = socketFactory;
    this.launchUrl = launchUrl;
  }

  static async connect(opts: DshClientOptions): Promise<DshClient> {
    const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    let launch: URL;
    try {
      launch = new URL(opts.launch_url);
    } catch {
      throw new DshRpcError("connect_failed", "launch URL is not a valid URL");
    }
    const token = launch.searchParams.get("token");
    if (!token) throw new DshRpcError("connect_failed", "launch URL has no token parameter");

    const connect = new URL("/connect", launch.origin);
    connect.searchParams.set("token", token);
    // API operators that do not answer forwarded interactions (browser-auth.ts:321-326).
    connect.searchParams.set("interactions", "none");

    let response: Response;
    try {
      response = await fetchImpl(connect.toString(), { redirect: "manual", signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    } catch (error) {
      throw new DshRpcError("connect_failed", `GET /connect failed: ${errorMessage(error)}`);
    }
    // Success is a 302 to ./api/remote.mux with set-cookie (browser-auth.ts:339-347).
    if (response.status !== 302 && !response.ok) {
      throw new DshRpcError("connect_failed", `GET /connect returned HTTP ${response.status}`, {
        http_status: response.status,
      });
    }
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]?.trim();
    if (!cookie) {
      throw new DshRpcError("connect_failed", "GET /connect did not issue an API cookie", {
        http_status: response.status,
      });
    }
    return new DshClient(launch.origin, cookie, fetchImpl, opts.launch_url, opts.socketFactory);
  }

  /** Each socket owns a separate read-only operator, revoked by DSH on socket close. */
  async *stream(method: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
    signal.throwIfAborted();
    // rpc-host.ts admits only one physical socket per API credential. A closed
    // socket also revokes that credential, so neither reuse the unary operator
    // nor retain a stream operator across reconnect generations.
    const owner = await DshClient.connect({ launch_url: this.launchUrl, fetch: this.fetchImpl, signal });
    yield* dshStream(owner.origin, owner.cookie, method, args, signal, this.socketFactory);
  }

  /** POST /api/<method> with payload { args }; returns result.value or throws DshRpcError. */
  async call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const rpcId = randomUUID();
    const body = { type: "client-request", rpcId, method, payload: { args } };
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`/api/${method}`, this.origin).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", cookie: this.cookie },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new DshRpcError("http_failed", `POST /api/${method} failed: ${errorMessage(error)}`, { method });
    }
    if (!response.ok) {
      throw new DshRpcError("http_failed", `POST /api/${method} returned HTTP ${response.status}`, {
        method,
        http_status: response.status,
      });
    }
    let envelope: ServerResponse;
    try {
      envelope = (await response.json()) as ServerResponse;
    } catch {
      throw new DshRpcError("http_failed", `POST /api/${method} returned a non-JSON body`, {
        method,
        http_status: response.status,
      });
    }
    // DSH's own client rejects mismatched correlation ids (client/connection/src/client/rpc.ts:66-68).
    if (envelope.rpcId !== undefined && envelope.rpcId !== rpcId) {
      throw new DshRpcError("http_failed", `rpcId mismatch for ${method}`, { method });
    }
    const result = envelope.result;
    if (result?.ok === true) return result.value as T;
    const failure = result?.ok === false ? result.error : undefined;
    throw new DshRpcError("rpc_failed", `${method} failed: ${failure?.message ?? "no result in envelope"}`, {
      method,
      http_status: response.status,
      code: failure?.code,
      details: failure?.details,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Method shapes from api/session-controller/src/types.ts (lines noted per type).

/** types.ts:149-162, trimmed to the fields the bridge reads. */
export interface DshSessionSummary {
  sessionId: string;
  agentAvailable: boolean;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
}

/** types.ts:259-268 */
export interface DshSessionCreateRequest {
  workspaceId?: string;
  cwd?: string;
  /** Reuses a blank session or names a new one; DSH may return a different id. */
  sessionId?: string;
  agentPreset?: string;
}

/** types.ts:271-276 */
export interface DshSessionCreateValue {
  sessionId: string;
  agentPreset?: string;
}

export interface DshSessionOptions {
  character_id?: string;
  project_id?: string;
  /** Working directory DSH owns for this session (types.ts:263). */
  cwd?: string;
}

// TODO(M3): unverified. Live session events come from the session/follow stream
// (typert.remote-client.d.ts:47, SessionFollowFrame), which is not served over the
// unary /api JSON channel. Event shapes are placeholders until the stream carrier is wired.
export interface DshEvent {
  type: string;
  payload?: unknown;
}

export type DshEventHandler = (event: DshEvent) => void;

/** One DSH session bound to a client. Method names from typert.remote-client.d.ts:43-55. */
export class DshSession {
  readonly session_id: string;
  readonly client: DshClient;

  private constructor(client: DshClient, session_id: string) {
    this.client = client;
    this.session_id = session_id;
  }

  /** session/create with args { request } (probe-session.mjs:32, typert.remote-client.d.ts:79). */
  static async create(client: DshClient, opts: DshSessionOptions = {}): Promise<DshSession> {
    const request: DshSessionCreateRequest = {};
    if (opts.cwd !== undefined) request.cwd = opts.cwd;
    const value = await client.call<DshSessionCreateValue>("session/create", { request });
    return new DshSession(client, value.sessionId);
  }

  /** Rebinds to an existing session id without a round trip; used when resuming a task. */
  static attach(client: DshClient, session_id: string): DshSession {
    return new DshSession(client, session_id);
  }

  /** session/list with args { _request } (probe-session.mjs:35, typert.remote-client.d.ts:83). */
  static async list(client: DshClient, cursor?: string): Promise<DshSessionSummary[]> {
    const _request = cursor === undefined ? {} : { cursor };
    const value = await client.call<{ items?: DshSessionSummary[] }>("session/list", { _request });
    return value.items ?? [];
  }

  /** session/prompt in queue mode (types.ts:315-328); resolves once DSH accepts the message. */
  async send(message: string): Promise<void> {
    await this.client.call<{ accepted: true }>("session/prompt", {
      request: {
        requestId: randomUUID(),
        sessionId: this.session_id,
        mode: "queue",
        content: [{ type: "text", text: message }],
      },
    });
  }

  /** session/cancel cancels the active turn (types.ts:355-362). */
  async cancel(): Promise<void> {
    await this.client.call<{ accepted: true }>("session/cancel", {
      request: { sessionId: this.session_id },
    });
  }

  // TODO(M3): unverified. Subscribe via session/follow once the stream carrier is available.
  onEvent(_handler: DshEventHandler): () => void {
    throw new Error("DshSession.onEvent: session/follow stream not wired yet (M3)");
  }
}
