// TypeScript mirror of contracts/task.schema.json (schema_version "0.1-draft").
// Keep this file in sync with the JSON schema; the schema is the source of truth.

export type TaskKind = "text" | "data" | "video" | "code" | "mixed";

export type TaskStatusKind =
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_approval"
  | "waiting_quota"
  | "waiting_external"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ArtifactKind = "text" | "data" | "video" | "code" | "image" | "subtitle" | "project";
export type ProductionMethod = "authored" | "analysis" | "generated" | "edited" | "mixed";
export type TechnicalCheck = "not_checked" | "passed" | "failed";
export type UserAcceptance = "pending" | "accepted" | "rejected";

/** $defs.artifact */
export interface Artifact {
  artifact_id: string;
  kind: ArtifactKind;
  path: string;
  /** Integer, starts at 1. */
  version: number;
  production_method: ProductionMethod;
  technical_check: TechnicalCheck;
  user_acceptance: UserAcceptance;
}

/** Lightweight pointer to an artifact, a subset of Artifact. */
export type ArtifactRef = Pick<Artifact, "artifact_id" | "kind" | "path" | "version">;

export type BillingSource = "dsh_account" | "third_party" | "local";
export type QuoteType = "unknown" | "estimate" | "provider_quote" | "settled";

/** $defs.billingItem */
export interface BillingItem {
  billing_source: BillingSource;
  provider: string;
  quote_type: QuoteType;
  /** Decimal string such as "1.20"; never a float. */
  amount: string | null;
  currency: string | null;
}

/** One task and its delivery record. */
export interface Task {
  schema_version: "0.1-draft";
  sample_only?: boolean;
  task_id: string;
  character_id: string;
  session_id: string;
  project_id: string;
  kind: TaskKind;
  status: TaskStatusKind;
  /** At least one, no duplicates. */
  required_artifact_kinds: ArtifactKind[];
  artifacts: Artifact[];
  billing: BillingItem[];
  external_job_id?: string | null;
  idempotency_key?: string | null;
}
