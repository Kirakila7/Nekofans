// Code task bridge stub (F15). Real diff and check execution lands in M3.

export interface DiffResult {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  diff_summary: string;
}

export type CheckKind = "lint" | "test" | "build";

export interface CheckResult {
  kind: CheckKind;
  status: "passed" | "failed";
  output: string;
}

const NOT_IMPLEMENTED = "Not implemented (F15 stub)";

function stub(name: string): never {
  console.log(`[dsh-bridge] ${name} called (stub)`);
  throw new Error(NOT_IMPLEMENTED);
}

export class CodeTaskBridge {
  static executeDiff(_task_id: string, _project_path: string): DiffResult {
    return stub("CodeTaskBridge.executeDiff");
  }

  static runChecks(_task_id: string, _check_kinds: CheckKind[]): CheckResult[] {
    return stub("CodeTaskBridge.runChecks");
  }
}
