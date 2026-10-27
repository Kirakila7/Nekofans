// F11: bind TTS playback lifecycle to avatar-runtime speaking state.
//
// speech_id (neko-tts) == playback_id (voice-adapter) == PlaybackId (avatar-runtime).
//   started      -> runtime.playbackStarted(id)
//   ended        -> runtime.playbackEnded(id)      (ignored unless id is current)
//   interrupted  -> runtime.interruptPlayback(id)  (also stops actions bound to id)
// "queued" does not change the avatar: speaking starts only when audio is audible.
// One speech channel: speak() preempts the previous playback, and because every
// clear is keyed by id, a late end of the old playback cannot clear the new one.

import type { AvatarRuntime } from "../../avatar-runtime/src/state-machine.ts";
import type { PlaybackEvent, PlaybackHandle, TtsPlayer } from "../../voice-adapter/src/tts.ts";

export interface SpeechSyncLogEntry {
  at: number;
  event: PlaybackEvent["type"];
  playback_id: string;
  /** Avatar state right after the event was applied. */
  avatar_state: string;
  avatar_playback_id: string | null;
}

export interface SpeechSyncOptions {
  now?: () => number;
  /** Called after each playback event is applied to the runtime. */
  onLog?: (entry: SpeechSyncLogEntry) => void;
}

export interface SpeechSync {
  /** Speak through the player; the avatar follows the playback lifecycle. */
  speak(text: string, character_id: string): PlaybackHandle;
  /** Stop the current playback (voice interrupt / barge-in). */
  interrupt(): boolean;
  current(): string | null;
  dispose(): void;
}

export function createSpeechSync(player: TtsPlayer, runtime: AvatarRuntime, options: SpeechSyncOptions = {}): SpeechSync {
  const now = options.now ?? (() => Date.now());

  const off = player.onPlaybackEvent((e) => {
    switch (e.type) {
      case "started":
        runtime.playbackStarted(e.playback_id);
        break;
      case "ended":
        runtime.playbackEnded(e.playback_id);
        break;
      case "interrupted":
        runtime.interruptPlayback(e.playback_id);
        break;
      case "queued":
        break;
    }
    if (options.onLog) {
      const r = runtime.resolve();
      options.onLog({ at: now(), event: e.type, playback_id: e.playback_id, avatar_state: r.state, avatar_playback_id: r.playback_id });
    }
  });

  return {
    speak: (text, character_id) => player.speak(text, character_id),
    interrupt() {
      if (player.current === null) return false;
      player.stopAll();
      return true;
    },
    current: () => player.current,
    dispose: off,
  };
}
