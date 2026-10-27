// Framework contracts only. No backend, API key, or runnable implementation is included.
export type PersonaId = string;
export interface Persona { id: PersonaId; name: string; prompt: string; memoryNamespace: string; }
export interface ChatMessage { id: string; personaId: PersonaId; conversationId: string; role: 'user' | 'assistant'; text: string; createdAt: number; }
export interface MemoryItem { id: string; personaId: PersonaId; kind: 'fact' | 'preference' | 'episode' | 'summary'; text: string; sourceMessageIds: string[]; confirmation: 'pending' | 'confirmed'; updatedAt: number; audioRef?: string; }
export interface MemoryProvider {
  recall(personaId: PersonaId, query: string, budgetTokens: number): Promise<MemoryItem[]>;
  propose(item: MemoryItem): Promise<void>;
  confirm(personaId: PersonaId, id: string): Promise<void>;
  update(personaId: PersonaId, id: string, text: string): Promise<void>;
  remove(personaId: PersonaId, id: string): Promise<void>;
}
export interface ConversationStore {
  append(message: ChatMessage): Promise<void>;
  recent(personaId: PersonaId, conversationId: string, limit: number): Promise<ChatMessage[]>;
}
export type ChatEvent = { type: 'delta'; text: string } | { type: 'complete'; messageId: string };
export interface ChatProvider {
  stream(input: { persona: Persona; messages: ChatMessage[]; memories: MemoryItem[]; maxOutputTokens: number; signal: AbortSignal }): AsyncIterable<ChatEvent>;
}
export interface MainChatState { personaId: PersonaId; phase: 'idle' | 'connecting' | 'replying' | 'error'; lastUserMessage?: string; reply?: string; }
export interface DshAgent { sessionId: string; parentSessionId: string; name: string; task: string; phase: 'idle' | 'working' | 'waiting' | 'success' | 'error'; pinned: boolean; nickname?: string; }
export interface DshBridge {
  listAgents(): Promise<DshAgent[]>;
  sendToAgent(sessionId: string, text: string): Promise<void>;
  stopAgent(sessionId: string): Promise<void>;
  subscribe(listener: (agents: DshAgent[]) => void): () => void;
}
// MainChatState intentionally has no DSH task/child state. Main chat has no DshBridge dependency.

export interface ProductBrand { name: string; workbenchTitle: string; mark: string; }
export interface PetSkin { id: string; name: string; renderer: "action-video" | "pngtuber"; assetPack: string; }
export interface PetIdentity { personaId: PersonaId; skinId: string; }
// Changing skinId must never mutate personaId, memory namespace, or conversations.

export type { MemoryMode, MemoryEvent, ReplicatedMemoryAdapter, MemoryModeController, FishKeepingSettings } from './memory-contracts';
