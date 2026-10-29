"""Offline worker protocol tests; no N.E.K.O. network calls or audio devices."""
import importlib.util
import io
import sys
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('neko_tts_worker', ROOT / 'apps/neko-workbench/tts-worker.py')
WORKER = importlib.util.module_from_spec(SPEC)
with redirect_stdout(io.StringIO()):
    SPEC.loader.exec_module(WORKER)


def synthetic_provider(frames):
    provider = types.ModuleType('providers')
    provider.FREE_DEFAULT_VOICE_ID = 'test-voice'
    def worker(requests, responses, key, voice):
        assert requests.get(timeout=1) == ('workbench', 'hello')
        assert requests.get(timeout=1) == (None, None)
        for frame in frames:
            responses.put(frame)
    provider.resolve_worker = lambda name: (worker, 'test')
    return provider


infra = types.ModuleType('main_logic.tts_client._infra')
infra.TTS_AUDIO_DONE_SENTINEL = '__audio_done__'
infra.TTS_SHUTDOWN_SENTINEL = '__shutdown__'
main_logic = types.ModuleType('main_logic'); main_logic.__path__ = []
tts_client = types.ModuleType('main_logic.tts_client'); tts_client.__path__ = []


class WorkerProtocolTest(unittest.TestCase):
    def execute(self, frames):
        emitted = []
        modules = {'providers': synthetic_provider(frames), 'main_logic': main_logic,
                   'main_logic.tts_client': tts_client, 'main_logic.tts_client._infra': infra}
        with patch.dict(sys.modules, modules), patch.object(sys, 'stdin', io.StringIO('{"text":"hello"}\n')), patch.object(WORKER, 'emit', emitted.append):
            WORKER.run()
        return emitted

    def test_pcm_then_done(self):
        self.assertEqual(self.execute([('__ready__', True), b'\x01\x02', ('__audio_done__', 'workbench')]),
                         [{'type': 'audio', 'pcm': 'AQI=', 'sampleRate': 48000}, {'type': 'ended'}])

    def test_sentence_failure_does_not_wait_for_done(self):
        with self.assertRaisesRegex(RuntimeError, 'free TTS unavailable'):
            self.execute([('__tts_sentence_failed__', 'workbench', '')])

    def test_server_error_before_done_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, 'free TTS unavailable'):
            self.execute([b'\x01\x02', ('__error__', 'service rejected'), ('__audio_done__', 'workbench')])

    def test_done_without_audio_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, 'no audio'):
            self.execute([('__audio_done__', 'workbench')])

    def test_invalid_pcm_is_failure(self):
        with self.assertRaisesRegex(RuntimeError, 'invalid PCM'):
            self.execute([b'\x01'])


if __name__ == '__main__':
    unittest.main()
