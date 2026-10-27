import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseMainChatConfig, type MainChatSettings } from "../../packages/chat-service/src/config.ts";
import { validateConfig } from "../../packages/chat-api/src/index.ts";
import { DEFAULT_PERSONA_ID, PersonaStore, validatePersonaFile, type PersonaFile } from "../../packages/persona-store/src/index.ts";

export const SETTINGS_CHANNELS = Object.freeze({ read: "neko-settings:read", api: "neko-settings:save-api", persona: "neko-settings:save-persona", section: "neko-settings:section" });
export type SettingsSection = "api" | "persona";
export type KeyChange = { action: "keep" | "clear" } | { action: "replace"; value: string };
export interface ApiChange { settings: MainChatSettings; key: KeyChange }

export function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** First run copies only the default persona; credentials and conversations never use the repo. */
export function initializeData(dataDir: string, repositoryRoot: string): { configFile: string; personasDir: string } {
  const personasDir = join(dataDir, "personas");
  mkdirSync(personasDir, { recursive: true });
  const target = join(personasDir, `${DEFAULT_PERSONA_ID}.json`);
  if (!existsSync(target)) {
    copyFileSync(join(repositoryRoot, "config", "personas", `${DEFAULT_PERSONA_ID}.json`), target, constants.COPYFILE_EXCL);
  } else {
    // Upgrade only the exact capability sentence shipped by the previous dev build.
    // Preserve all user-authored persona text, names, boundaries and extension fields.
    const persona = validatePersonaFile(JSON.parse(readFileSync(target, "utf8")));
    const old = "不能直接布置或执行 DSH 任务。当前开发版本尚未接入内置 DSH，用户需要执行任务时应如实说明。";
    if (persona.boundaries?.includes(old)) {
      atomicJson(target, { ...persona, boundaries: persona.boundaries.map((line) => line === old
        ? "不能直接布置或执行 DSH 任务。用户需要执行任务时，可以通过主角色右键菜单打开内置 DSH，在工作台中发起任务。" : line) });
    }
  }
  return { configFile: join(dataDir, "app-config.json"), personasDir };
}

export function readSettings(configFile: string): MainChatSettings {
  const raw = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  const settings = parseMainChatConfig(raw.mainChat);
  // The v1 desktop has one main persona. Additional personas are a separate feature.
  if (settings.personaId !== DEFAULT_PERSONA_ID) throw new Error("Unsupported desktop persona.");
  return settings;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings.");
  return value as Record<string, unknown>;
}

function shortString(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("Invalid settings.");
  return value.trim();
}

/** Explicit whitelist: never spreads renderer input into the non-secret config. */
export function parseApiChange(raw: unknown): ApiChange {
  const input = object(raw);
  const settings = parseMainChatConfig({
    personaId: DEFAULT_PERSONA_ID,
    protocol: shortString(input.protocol, 40),
    baseUrl: shortString(input.baseUrl, 2048),
    model: shortString(input.model, 200),
    requestTimeoutMs: input.requestTimeoutMs,
    maxOutputTokens: input.maxOutputTokens,
  });
  if (settings.requestTimeoutMs > 300_000) throw new Error("Invalid settings.");
  // Empty URL + model can deliberately return the application to its initial unconfigured state.
  if (settings.baseUrl || settings.model) {
    validateConfig(settings);
    const url = new URL(settings.baseUrl);
    // Credentials in URL/query would be persisted in clear text; keys have a separate field.
    if (url.username || url.password || url.search || url.hash) throw new Error("Invalid API URL.");
  }
  const keyRaw = object(input.key);
  let key: KeyChange;
  if (keyRaw.action === "keep" || keyRaw.action === "clear") key = { action: keyRaw.action };
  else if (keyRaw.action === "replace") {
    const value = shortString(keyRaw.value, 16_384);
    if (!value || /[\r\n]/.test(value)) throw new Error("Invalid API key.");
    key = { action: "replace", value };
  } else throw new Error("Invalid API key action.");
  return { settings, key };
}

/** Keep identity/namespace/appearance from the trusted existing file. */
export function parsePersonaChange(raw: unknown, current: PersonaFile): PersonaFile {
  const input = object(raw);
  const name = shortString(input.name, 80);
  const persona = shortString(input.persona, 12_000);
  if (!Array.isArray(input.boundaries) || input.boundaries.length > 30) throw new Error("Invalid boundaries.");
  const boundaries = input.boundaries.map((line) => shortString(line, 1000)).filter(Boolean);
  return validatePersonaFile({ ...current, name, persona, boundaries });
}

export function readPersona(personasDir: string): PersonaFile {
  return new PersonaStore(personasDir).getFile(DEFAULT_PERSONA_ID);
}

export interface SettingsSender {
  sender: unknown;
  senderFrame?: { url: string } | null;
}

/** Reject subframes, another window, and a trusted window navigated away from the settings page. */
export function isSettingsSender(event: SettingsSender, contents: { mainFrame: unknown; getURL(): string; isDestroyed(): boolean }, expectedUrl: string): boolean {
  return !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame
    && event.senderFrame?.url === expectedUrl && contents.getURL() === expectedUrl;
}
