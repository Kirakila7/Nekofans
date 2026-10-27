// Video task bridge stub (F14). Real provider integration lands in M3.

export interface VideoGenerationOpts {
  task_id: string;
  provider: string;
  prompt: string;
  duration_sec: number;
}

export interface VideoSubmitResult {
  external_job_id: string;
  idempotency_key: string;
}

export interface JobStatus {
  status: "queued" | "processing" | "completed" | "failed";
  result_url?: string;
  error?: string;
}

const NOT_IMPLEMENTED = "Not implemented (F14 stub)";

function stub(name: string): never {
  console.log(`[dsh-bridge] ${name} called (stub)`);
  throw new Error(NOT_IMPLEMENTED);
}

export const VideoTaskBridge = {
  submitGenerationRequest(_opts: VideoGenerationOpts): VideoSubmitResult {
    return stub("VideoTaskBridge.submitGenerationRequest");
  },

  pollStatus(_external_job_id: string): JobStatus {
    return stub("VideoTaskBridge.pollStatus");
  },

  downloadResult(_external_job_id: string, _dest_path: string): void {
    stub("VideoTaskBridge.downloadResult");
  },
};
