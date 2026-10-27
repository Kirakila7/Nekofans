// TypeScript mirror of contracts/appearance-pack.schema.json (schema_version "0.1-draft").
// Keep this file in sync with the JSON schema; the schema is the source of truth.

export type RendererType = "pngtuber" | "video";
export type VoiceSelection = "choose_at_import" | "keep_existing";

/** Relative path inside the pack: no leading "/", no "\\", no drive letter, no ".." segment. */
export type RelativePath = string;

export interface CharacterTemplate {
  name: string;
  persona: string;
  voice_selection?: VoiceSelection;
}

export interface PngtuberRenderer {
  model_path: RelativePath;
}

export interface VideoRenderer {
  /** Clip lists keyed by action name; "idle" is required, each list has at least one clip. */
  clips: { idle: RelativePath[] } & Record<string, RelativePath[]>;
}

export interface AppearanceRenderers {
  pngtuber?: PngtuberRenderer;
  video?: VideoRenderer;
}

/** An importable appearance pack. renderers must contain the entry named by default_renderer. */
export interface AppearancePack {
  schema_version: "0.1-draft";
  sample_only?: boolean;
  pack_id: string;
  appearance_id: string;
  display_name: string;
  character_template: CharacterTemplate;
  default_renderer: RendererType;
  renderers: AppearanceRenderers;
}
