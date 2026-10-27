import { randomUUID } from "node:crypto";

/** Node's built-in (Undici) WebSocket accepts handshake headers in WebSocketInit. */
export type DshSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;
const nativeSocket: DshSocketFactory = (url, headers) => new WebSocket(url, { headers } as unknown as string[]);

/** Gateway wire contract: api/gateway/src/stream-protocol.ts. Never forwards Host error text. */
export async function* dshStream(origin: string, cookie: string, endpoint: string, args: Record<string, unknown>,
  signal: AbortSignal, createSocket: DshSocketFactory = nativeSocket): AsyncIterable<unknown> {
  signal.throwIfAborted();
  const url = new URL("/api/remote.mux", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = createSocket(url.toString(), { cookie });
  const streamId = randomUUID();
  const queue: unknown[] = [];
  let failure: Error | undefined, ended = false, wake = () => {};
  const fail = () => { failure ??= new Error("DSH event stream unavailable."); wake(); };
  const timeout = setTimeout(fail, 10_000);
  const abort = () => { failure = new DOMException("DSH event stream cancelled.", "AbortError"); wake(); };
  const open = () => socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
  const message = (event: MessageEvent) => {
    if (ended || failure) return;
    try {
      if (typeof event.data !== "string") throw new Error();
      const frame = JSON.parse(event.data);
      if (frame?.streamId !== streamId) throw new Error();
      clearTimeout(timeout);
      if (frame.type === "item") {
        if (queue.length >= 1024) throw new Error();
        queue.push(frame.value);
      } else if (frame.type === "end") ended = true;
      else throw new Error();
      wake();
    } catch { fail(); }
  };
  socket.addEventListener("open", open);
  socket.addEventListener("message", message);
  socket.addEventListener("error", fail);
  socket.addEventListener("close", fail);
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!ended || queue.length) {
      if (failure) throw failure;
      if (queue.length) yield queue.shift();
      else await new Promise<void>((resolve) => { wake = resolve; });
    }
    if (failure) throw failure;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    socket.removeEventListener("open", open);
    socket.removeEventListener("message", message);
    socket.removeEventListener("close", fail);
    // Retain a no-op error listener while a connecting socket is closed.
    socket.removeEventListener("error", fail);
    socket.addEventListener("error", () => {}, { once: true });
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: "cancel", streamId }));
    if (socket.readyState < 2) socket.close();
  }
}
