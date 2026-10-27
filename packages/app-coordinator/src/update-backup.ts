// F18: installer updater and backup service (spec stubs).
// Real implementation lands in M4. Every method logs its call and throws
// so callers fail loudly instead of silently.

import type { BackupManifest } from "../../memory-adapter/src/correction-backup.ts";

export type { BackupManifest };

export const NOT_IMPLEMENTED_MESSAGE = "Not implemented (F18 stub)";

function notImplemented(name: string): never {
  console.log(`[app-coordinator] ${name} (F18 stub)`);
  throw new Error(NOT_IMPLEMENTED_MESSAGE);
}

/** Result of an update check. */
export interface UpdateCheckResult {
  available: boolean;
  version?: string;
}

/** Download progress event emitted while an update is being fetched. */
export interface DownloadProgress {
  transferred_bytes: number;
  total_bytes: number;
  percent: number;
}

/** Summary of a stored backup. */
export interface BackupInfo {
  backup_id: string;
  character_ids: string[];
  /** ISO 8601 timestamp of when the backup was created. */
  backup_date: string;
  size_bytes: number;
}

export const UpdateService = {
  checkForUpdates(): UpdateCheckResult {
    return notImplemented("UpdateService.checkForUpdates()");
  },
  downloadAndInstall(): void {
    notImplemented("UpdateService.downloadAndInstall()");
  },
  onDownloadProgress(handler: (progress: DownloadProgress) => void): void {
    void handler;
    notImplemented("UpdateService.onDownloadProgress()");
  },
};

export const BackupService = {
  scheduleAutoBackup(interval_days: number): void {
    notImplemented(`BackupService.scheduleAutoBackup(${interval_days})`);
  },
  createManualBackup(dest_path: string): BackupManifest {
    return notImplemented(`BackupService.createManualBackup(${dest_path})`);
  },
  listBackups(): BackupInfo[] {
    return notImplemented("BackupService.listBackups()");
  },
};
