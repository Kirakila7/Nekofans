// Public entry for voice-adapter. ASR (F10) and TTS (F11) live in separate modules.

import { onTranscriptFinal, startRecording } from "./asr.ts";
import { speak } from "./tts.ts";

export type { RecordingHandle, TranscriptFinalHandler } from "./asr.ts";
export type { PlaybackHandle } from "./tts.ts";

export * from "./asr.ts";
export * from "./tts.ts";

export const VoiceService = { startRecording, onTranscriptFinal, speak };
