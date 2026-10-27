/**
 * v3 product and native-workbench boundary contracts.
 * These declarations do not connect Chat API, N.E.K.O. or memory adapters.
 * Existing contracts.ts / memory-contracts.ts and the v2 kernel remain unchanged.
 */
import type { PersonaId as MemoryPersonaId } from './contracts';

declare const workbenchIdentity: unique symbol;
type BoundId<Kind extends string> = string & { readonly [workbenchIdentity]: Kind };

/** Stable memory identity. Never derive it from avatar, role label or account. */
export type PersonaId = MemoryPersonaId & BoundId<'PersonaId'>;
/** Native runtime identity, resolved from an already existing DSH Session. */
export type SessionId = BoundId<'SessionId'>;
export type AccountConnectionId = BoundId<'AccountConnectionId'>;
/** This reference belongs only to native secure storage, never a UI snapshot. */
export type NativeCredentialRef = BoundId<'NativeCredentialRef'>;

export type GlobalAvatarId = 'yui' | 'devcat' | 'bigfish' | 'claude' | 'gemini' | 'custom';
export type BuiltinAvatarId = Exclude<GlobalAvatarId, 'custom'>;
export type WorkbenchRoleId = 'yui' | 'bigfish' | 'claude';
export type AccountProviderId = 'deepseek' | 'neko' | 'codex' | 'claude' | 'gemini';
export type WalletCurrency = 'CNY' | 'USD';

export interface GlobalAppearance {
  selectedId: GlobalAvatarId;
  customImageSource: 'native-picker';
  customImagePersistence: 'local-only';
  customColorExtraction: 'local-only';
  changesPersona: false;
  changesMemoryNamespace: false;
  changesAccount: false;
}

export interface WorkbenchTheme {
  followGlobalAvatar: true;
  presetIds: readonly BuiltinAvatarId[];
  customPalette: 'local-image-dominant-color';
  mode: 'follow-native-light-dark';
  habitatBackgroundToken: '--neko-account-habitat-bg';
  changesModelOrQuota: false;
}

export interface ExistingDshRootBinding {
  kind: 'existing-dsh-root';
  source: 'runtime.state.dshRoot.sessionId';
  /** Null in distributable configuration; native runtime supplies the real id. */
  sessionId: SessionId | null;
  createOnSelection: false;
}

interface RoleAppearance {
  name: string;
  avatarId: GlobalAvatarId;
  customizable: readonly ('name' | 'avatarId')[];
  /** A role seat is not a memory persona or an account connection. */
  personaId?: never;
  credentialRef?: never;
}
export type WorkbenchRole =
  | (RoleAppearance & { id: 'bigfish'; enabled: true; sessionBinding: ExistingDshRootBinding })
  | (RoleAppearance & { id: 'yui' | 'claude'; enabled: false; sessionBinding: null });

/** Safe native read projection. Does not contain a token, secret or account id. */
export interface NativeAccountView {
  status: 'signed-out' | 'credential-stored';
  attempt: { id: string; phase: string } | null;
  links: { usageUrl: string; topUpUrl: string };
}

/** Exact wallet data returned inside the native getBalance ready outcome. */
export interface NativeWallet {
  currency: WalletCurrency;
  /** Exact decimal string; do not coerce through floating-point Number. */
  balance: string;
}
export type NativeBalanceOutcome =
  | { status: 'ready'; value: readonly NativeWallet[]; bonusWallets: readonly NativeWallet[] }
  | { status: 'failed' }
  | null;
export type RemoteReadResult<Value> = { ok: true; value: Value } | { ok: false; error: unknown };
export interface AccountClientMetadata {
  version: string;
  locale: string;
  timezoneOffsetSeconds: number;
}

export type ReadOnlyWallet =
  | {
      status: 'ready';
      currency: WalletCurrency;
      /** Formatted original-currency display, such as ¥0.00 or <$0.01. */
      amount: string;
      source: 'DeepSeek 官方充值钱包';
      fetchedAt: string;
    }
  | {
      status: 'unknown' | 'unavailable' | 'loading' | 'signed-out' | 'error';
      currency: null;
      amount: null;
      source: 'DeepSeek 官方充值钱包';
      fetchedAt: null;
    };

/** Frontend account identity is assigned by a native adapter, never invented by UI. */
export interface AccountConnection {
  accountId: AccountConnectionId;
  providerId: AccountProviderId;
  kind: 'inference-account' | 'product-identity' | 'usage-source';
  status: 'connected' | 'signed-out' | 'expired' | 'unknown';
  redactedLabel: string;
  wallet: ReadOnlyWallet;
  credentialRef?: never;
  apiKey?: never;
  accessToken?: never;
  refreshToken?: never;
  password?: never;
}

/** Native-only record; this interface is deliberately not part of UI snapshots. */
export interface NativeAccountSecretBinding {
  visibility: 'native-only';
  accountId: AccountConnectionId;
  credentialRef: NativeCredentialRef;
}

export interface AccountHabitatPet {
  accountId: AccountConnectionId;
  providerId: 'deepseek';
  appearanceId: 'bigfish';
  videoAsset: 'assets/idle.webm';
  videoFit: 'cover-center';
  reducedMotion: 'static-poster';
  backgroundToken: '--neko-account-habitat-bg';
}

export interface ReadOnlyAccountApi {
  getState(): Promise<RemoteReadResult<NativeAccountView>>;
  getBalance(client: AccountClientMetadata): Promise<RemoteReadResult<NativeBalanceOutcome>>;
}

export interface WorkbenchRoleSnapshot {
  activeId: 'bigfish';
  workspaceSessionId: SessionId | null;
  roles: readonly [
    Extract<WorkbenchRole, { id: 'yui' | 'claude' }>,
    Extract<WorkbenchRole, { id: 'bigfish' }>,
    Extract<WorkbenchRole, { id: 'yui' | 'claude' }>,
  ];
}

/** Existing native bridge contract; it does not create Sessions or send prompts. */
export interface WorkbenchRoleBridge {
  getState(): Promise<WorkbenchRoleSnapshot>;
  selectRole(id: 'bigfish'): Promise<WorkbenchRoleSnapshot>;
  updateRole(id: WorkbenchRoleId, patch: { name?: string; avatarId?: GlobalAvatarId }): Promise<WorkbenchRoleSnapshot>;
  uploadAvatar(id: WorkbenchRoleId): Promise<WorkbenchRoleSnapshot | null>;
  subscribe(listener: (state: WorkbenchRoleSnapshot) => void): () => void;
}

export type WorkbenchOptionId = 'nekoSettings' | 'openNeko' | 'taskNotes' | 'connect' | 'status' | 'reconnect';
export type NativeWorkbenchAction = 'neko-settings' | 'open-neko' | 'task-notes' | 'connect-neko' | 'connection-status' | 'reconnect-workbench';
export interface WorkbenchOption {
  id: WorkbenchOptionId;
  label: string;
  nativeAction: NativeWorkbenchAction;
  explicitUserActionOnly?: true;
}

export interface PlannedMainChatAndMemory {
  chatApi: { status: 'planned'; connected: false; configurationRef: string };
  dualMemory: { status: 'planned'; nativeAdaptersConnected: false; configurationRef: string; referenceKernel: string };
  fishKeeping: { status: 'planned'; connected: false; configurationRef: string };
}

/** Repository addition: open the existing community without sharing DSH state. */
export interface CommunityNavigation {
  id: 'community';
  label: '社区';
  placement: 'after-new-session-before-roles';
  nativeAction: 'open-community';
  defaultUrl: 'https://community.project-neko.cn/feed';
  targetSource: 'native-config';
  openIn: 'isolated-native-window';
  sessionPartition: 'persist:neko-community';
  sharesDshCredentials: false;
  createsTask: false;
  nativeAccountIntegration: 'planned';
}

export interface WorkbenchConfigBoundary {
  schemaVersion: 1;
  runtime: {
    backend: 'embedded-dsh';
    workspaceSessionId: SessionId | null;
    autoStartServices: false;
    autoAuthenticate: false;
    autoTopUp: false;
    autoSelectModel: false;
  };
  roles: readonly WorkbenchRole[];
  options: readonly WorkbenchOption[];
  plannedIntegrations: PlannedMainChatAndMemory;
  navigation?: { community: CommunityNavigation };
}
