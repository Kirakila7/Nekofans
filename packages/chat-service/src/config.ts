// Framework v1 main-chat settings ("mainChat" section of app config) and the wiring that
// opens a ready MainChatService: persona store, conversation history, key store, provider.
// URL/https checks happen in chat-api validateConfig at send time, so an unconfigured app
// still starts and reports not_configured on the first message.

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { DpapiSecretStore, createChatApiProvider } from "../../chat-api/src/index.ts";
import type { ChatProtocol, SecretStore } from "../../chat-api/src/index.ts";
import { SqliteConversationStore } from "../../conversation-store/src/index.ts";
import { SqliteMemoryStore, extractMemoryProposals, type PersonaMemory } from "../../memory-store/src/index.ts";
import { DEFAULT_PERSONA_ID, PersonaStore } from "../../persona-store/src/index.ts";
import type { MemoryProvider } from "../../app-contracts/src/chat.ts";
import { MainChatService } from "./service.ts";
import { SqliteSummaryStore } from "../../memory-store/src/summaries.ts";
import type { PersonaSummaries } from "../../app-contracts/src/summary.ts";

export interface MainChatSettings {
  personaId: string;
  protocol: ChatProtocol;
  baseUrl: string;
  model: string;
  requestTimeoutMs: number;
  maxOutputTokens: number;
}

const PROTOCOLS: readonly ChatProtocol[] = ["openai-compatible", "anthropic"];

function optionalString(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`mainChat.${key} must be a string`);
  return value.trim();
}

function optionalInt(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`mainChat.${key} must be an integer`);
  if (value < min || value > max) throw new Error(`mainChat.${key} must be between ${min} and ${max}`);
  return value;
}

/** Parses the "mainChat" section. provider, apiKeyStorage and stream are ignored. */
export function parseMainChatConfig(raw: unknown): MainChatSettings {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("mainChat must be an object");
  const obj = raw as Record<string, unknown>;
  const personaId = optionalString(obj, "personaId", DEFAULT_PERSONA_ID) || DEFAULT_PERSONA_ID;
  const protocol = optionalString(obj, "protocol", "openai-compatible");
  if (!PROTOCOLS.includes(protocol as ChatProtocol)) {
    throw new Error(`mainChat.protocol must be one of ${PROTOCOLS.join(", ")}`);
  }
  return {
    personaId,
    protocol: protocol as ChatProtocol,
    baseUrl: optionalString(obj, "baseUrl", ""),
    model: optionalString(obj, "model", ""),
    requestTimeoutMs: optionalInt(obj, "requestTimeoutMs", 60_000, 1000, Number.MAX_SAFE_INTEGER),
    maxOutputTokens: optionalInt(obj, "maxOutputTokens", 1024, 1, 32_000),
  };
}

export interface OpenMainChatOptions {
  settings: MainChatSettings;
  personasDir: string;
  /** Holds conversations.sqlite, memories.sqlite and secrets/; created when missing. */
  dataDir: string;
  fetch?: typeof globalThis.fetch;
  /** Default: DPAPI file at <dataDir>/secrets/chat-api-key.dpapi. */
  secretStore?: SecretStore;
  memory?: MemoryProvider;
}

export interface OpenedMainChat {
  service: MainChatService;
  /** Memory management is bound to this character; callers cannot choose another persona. */
  memory: PersonaMemory | undefined;
  summaries: PersonaSummaries;
  /** The key store the provider reads, for a settings UI to set or clear the key. */
  secretStore: SecretStore;
  close(): void;
}

export function openMainChat(opts: OpenMainChatOptions): OpenedMainChat {
  const { settings, dataDir } = opts;
  mkdirSync(dataDir, { recursive: true });
  const personas = new PersonaStore(opts.personasDir);
  // Fail fast on a missing or invalid persona file instead of at the first message.
  personas.get(settings.personaId);
  const secretStore = opts.secretStore ?? new DpapiSecretStore(join(dataDir, "secrets", "chat-api-key.dpapi"));
  const conversations = new SqliteConversationStore(join(dataDir, "conversations.sqlite"));
  let localMemory: SqliteMemoryStore | undefined;
  let summaries: SqliteSummaryStore | undefined;
  try {
    // An injected provider owns its own lifecycle. The default is independent local memory,
    // with no dependency on the N.E.K.O. service or any other character's data.
    if (!opts.memory) localMemory = new SqliteMemoryStore(join(dataDir, "memories.sqlite"));
    const memory = opts.memory ?? localMemory;
    const provider = createChatApiProvider({
      config: {
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        model: settings.model,
        requestTimeoutMs: settings.requestTimeoutMs,
      },
      getApiKey: () => secretStore.get(),
      fetch: opts.fetch,
    });
    // Continue the latest conversation so history survives a restart.
    const conversationId = conversations.latestConversationId(settings.personaId) ?? `main-${randomUUID()}`;
    summaries = new SqliteSummaryStore(join(dataDir, "memories.sqlite"), conversations);
    const service = new MainChatService({
      persona: () => personas.get(settings.personaId),
      provider,
      conversations,
      memory,
      summaries,
      proposeMemories: extractMemoryProposals,
      conversationId,
      maxOutputTokens: settings.maxOutputTokens,
    });
    let closed = false;
    return {
      service,
      memory: localMemory?.forPersona(settings.personaId),
      summaries: summaries.forConversation(settings.personaId, conversationId),
      secretStore,
      close() {
        if (closed) return;
        closed = true;
        service.dispose();
        summaries?.close();
        conversations.close();
        localMemory?.close();
      },
    };
  } catch (error) {
    conversations.close();
    summaries?.close();
    localMemory?.close();
    throw error;
  }
}
