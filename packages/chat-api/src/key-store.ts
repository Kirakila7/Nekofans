// Chat API key storage. Windows only: the key is encrypted with DPAPI (CurrentUser scope,
// the same mechanism Electron safeStorage uses on Windows) and the ciphertext is written to
// a file outside the repo. Plain text never touches disk, the renderer or logs.
// PowerShell does the DPAPI call; the secret travels over stdin (base64), never the command line.

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface SecretStore {
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
  clear(): Promise<void>;
  has(): boolean;
  /** Main-process-only rollback capability; implementations need not decrypt stored bytes. */
  prepareRollback?(): Promise<() => Promise<void>>;
}

const PROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd().Trim();" +
  "$e=[Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($s),$null,'CurrentUser');" +
  "[Console]::Out.Write([Convert]::ToBase64String($e))";
const UNPROTECT =
  "Add-Type -AssemblyName System.Security;" +
  "$s=[Console]::In.ReadToEnd().Trim();" +
  "$d=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s),$null,'CurrentUser');" +
  "[Console]::Out.Write([Convert]::ToBase64String($d))";

/** Runs one PowerShell script with input on stdin; resolves with trimmed stdout. */
function powershell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20_000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        // stderr may echo the input on failure; it is dropped on purpose.
        if (error) reject(new Error("DPAPI call failed."));
        else resolve(stdout.trim());
      },
    );
    child.stdin?.end(stdin, "utf8");
  });
}

// Plain text crosses the pipe as base64 in both directions so non-ASCII survives the
// console code page.
export async function dpapiProtect(plain: string): Promise<string> {
  return powershell(PROTECT, Buffer.from(plain, "utf8").toString("base64"));
}

export async function dpapiUnprotect(cipherBase64: string): Promise<string> {
  return Buffer.from(await powershell(UNPROTECT, cipherBase64), "base64").toString("utf8");
}

/** DPAPI-encrypted secret in one file. The decrypted value is cached in memory after first use. */
export class DpapiSecretStore implements SecretStore {
  private readonly file: string;
  private cache: string | null | undefined;

  constructor(file: string) {
    if (process.platform !== "win32") throw new Error("DpapiSecretStore is Windows only.");
    this.file = file;
  }

  has(): boolean {
    return existsSync(this.file);
  }

  async get(): Promise<string | null> {
    if (this.cache !== undefined) return this.cache;
    if (!this.has()) return (this.cache = null);
    const cipher = readFileSync(this.file, "utf8").trim();
    this.cache = cipher.length === 0 ? null : await dpapiUnprotect(cipher);
    return this.cache;
  }

  async set(secret: string): Promise<void> {
    const value = secret.trim();
    if (value.length === 0) throw new Error("Secret is empty.");
    const cipher = await dpapiProtect(value);
    this.writeCipher(cipher);
    this.cache = value;
  }

  async prepareRollback(): Promise<() => Promise<void>> {
    // Preserve exact stored bytes, even when DPAPI cannot decrypt them after a
    // Windows-account change or file corruption. Never expose the snapshot to IPC.
    const previous = this.has() ? readFileSync(this.file) : null;
    return async () => {
      if (previous === null) await this.clear();
      else {
        this.writeCipher(previous);
        this.cache = undefined;
      }
    };
  }

  private writeCipher(cipher: string | Buffer): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, cipher, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }

  async clear(): Promise<void> {
    rmSync(this.file, { force: true });
    this.cache = null;
  }
}

/** Test and dev helper; keeps the secret in memory only. */
export class MemorySecretStore implements SecretStore {
  private value: string | null;
  constructor(value: string | null = null) {
    this.value = value;
  }
  has(): boolean {
    return this.value !== null;
  }
  async get(): Promise<string | null> {
    return this.value;
  }
  async set(secret: string): Promise<void> {
    this.value = secret.trim();
  }
  async clear(): Promise<void> {
    this.value = null;
  }
  async prepareRollback(): Promise<() => Promise<void>> {
    const previous = this.value;
    return async () => { this.value = previous; };
  }
}
