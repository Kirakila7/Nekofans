// Minimal server-sent events reader over a fetch Response body.
// Yields the data payload of each event; comments, ids and retry fields are ignored.

export interface SseEvent {
  event: string | null;
  data: string;
}

/** Splits a byte stream into SSE events. Multi-line data fields are joined with "\n". */
export async function* readSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n") };
          event = null;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let rest = colon < 0 ? "" : line.slice(colon + 1);
        if (rest.startsWith(" ")) rest = rest.slice(1);
        if (field === "data") data.push(rest);
        else if (field === "event") event = rest;
      }
    }
    // A stream that ends without a trailing blank line still delivers its last event.
    if (data.length > 0) yield { event, data: data.join("\n") };
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
