// F13 stub: artifact registration, validation and viewer. Real file check + preview land in M3.
// Contract types come from app-contracts (mirror of contracts/task.schema.json $defs.artifact).

import type {
  ArtifactKind,
  ArtifactRef,
  ProductionMethod,
  TechnicalCheck,
  UserAcceptance,
} from "../../app-contracts/src/index.ts";

export type { ArtifactKind, ArtifactRef, ProductionMethod, TechnicalCheck, UserAcceptance };

export interface ArtifactPayload {
  task_id: string;
  kind: ArtifactKind;
  path: string;
  production_method: ProductionMethod;
}

export interface ValidationResult {
  technical_check: TechnicalCheck;
  user_acceptance: UserAcceptance;
  errors?: string[];
}

// F16 stub: artifact versioning and idempotency. Real version tracking lands in M3.
export interface VersionInfo {
  version: number;
  path: string;
  created_at: string;
  user_acceptance: UserAcceptance;
}

export interface IdempotencyResult {
  exists: boolean;
  artifact_id?: string;
}

const NOT_IMPLEMENTED = "Not implemented (F13 stub)";
const NOT_IMPLEMENTED_F16 = "Not implemented (F16 stub)";

function stub(name: string, ...args: unknown[]): never {
  console.log(`[artifact-service] ${name} called`, ...args);
  throw new Error(NOT_IMPLEMENTED);
}

function stubF16(name: string, ...args: unknown[]): never {
  console.log(`[artifact-service] ${name} called`, ...args);
  throw new Error(NOT_IMPLEMENTED_F16);
}

export const ArtifactService = {
  register(artifact: ArtifactPayload): { artifact_id: string } {
    stub("register", artifact);
  },
  validate(artifact_id: string): ValidationResult {
    stub("validate", artifact_id);
  },
  openInViewer(artifact_id: string): void {
    stub("openInViewer", artifact_id);
  },
  listByTask(task_id: string): ArtifactRef[] {
    stub("listByTask", task_id);
  },
  createVersion(artifact_id: string, new_path: string): { version: number } {
    stubF16("createVersion", artifact_id, new_path);
  },
  listVersions(artifact_id: string): VersionInfo[] {
    stubF16("listVersions", artifact_id);
  },
  checkIdempotency(idempotency_key: string): IdempotencyResult {
    stubF16("checkIdempotency", idempotency_key);
  },
};
