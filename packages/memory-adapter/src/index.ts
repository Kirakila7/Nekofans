// Entry for memory-adapter package.

export {
  MemoryClient,
  type MemoryClientOptions,
  type Receipt,
  type SubmittedReceipt,
  type AlreadySubmitted,
  type CommitError,
  type CommitErrorCode,
  type ReceiptStatus,
  toInputHistory,
  DEFAULT_MEMORY_SERVICE_URL,
  // F07 exports
  type Fact,
  type MemoryContext,
  type RecentLine,
  type StoredFact,
  type Reflection,
  MemoryServiceError,
  parseNewDialog,
} from "./memory-client.ts";

export {
  correctFact,
  exportBackup,
  forgetFact,
  restoreBackup,
  type BackupFiles,
  type BackupManifest,
  type RestoreResult,
} from "./correction-backup.ts";

