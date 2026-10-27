// Framework v1 ChatApiAdapter public surface.

export {
  ChatApiError,
  buildSystemPrompt,
  createChatApiProvider,
  endpointUrl,
  toWireMessages,
  validateConfig,
} from "./provider.ts";
export type { ChatApiConfig, ChatApiErrorCode, ChatApiProviderOptions, ChatProtocol } from "./provider.ts";
export { DpapiSecretStore, MemorySecretStore, dpapiProtect, dpapiUnprotect } from "./key-store.ts";
export type { SecretStore } from "./key-store.ts";
export { readSse } from "./sse.ts";
export type { SseEvent } from "./sse.ts";
