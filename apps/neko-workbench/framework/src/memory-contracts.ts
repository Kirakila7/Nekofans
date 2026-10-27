import type { PersonaId } from './contracts';

export type MemoryMode = 'diary' | 'neko';
export type MemoryVisibility = 'owner' | 'private';
export interface SharedMemoryValue {
  kind: 'fact' | 'preference' | 'episode' | 'summary';
  text: string;
  visibility: MemoryVisibility;
  certainty: 'candidate' | 'inferred' | 'user-confirmed';
  evidenceRefs: string[];
  nativeRef?: { provider: MemoryMode; id: string; nativeStatus?: string };
  audioRef?: string;
}
export interface MemoryEvent {
  eventId: string;
  itemId: string;
  personaId: PersonaId;
  origin: MemoryMode | 'user';
  operation: 'upsert' | 'delete' | 'restore';
  parents: string[];
  occurredAt: string;
  value?: SharedMemoryValue;
}
export interface MemoryCapabilities {
  protocol: 1;
  pull: boolean;
  push: boolean;
  idempotency: boolean;
  tombstones: boolean;
  privateMemory: boolean;
}
export interface ReplicatedMemoryAdapter {
  readonly personaId: PersonaId;
  health(): Promise<{ ready: boolean; capabilities: MemoryCapabilities; reason?: string }>;
  pull(cursor?: string): Promise<{ events: MemoryEvent[]; nextCursor: string }>;
  push(events: MemoryEvent[]): Promise<{ ackedEventIds: string[] }>;
  recall(query: string, tokenBudget: number): Promise<SharedMemoryValue[]>;
}
// Native N.E.K.O. and free-form diaries need adapter mappings. These are product
// contracts, not a claim that either upstream exposes these endpoints today.
export interface MemoryModeController {
  current(): MemoryMode;
  switchTo(mode: MemoryMode): Promise<void>;
  sync(): Promise<void>;
  status(): { pending: number; conflicts: number; providerStates: Partial<Record<MemoryMode, string>> };
}
export interface FishKeepingSettings {
  personaId: PersonaId;
  mode: MemoryMode;
  autoSync: boolean;
  lifeEnabled: boolean;
  biliEnabled: boolean;
  biliWriteActions: boolean;
}
