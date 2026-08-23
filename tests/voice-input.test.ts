import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendVoiceTranscript,
  microphoneAccessErrorMessage,
  requestMicrophoneAccess,
  speechRecognitionErrorMessage,
} from '../lib/ai/voice-input';

test('voice input explains denied microphone permission', () => {
  const error = new Error('Permission denied');
  error.name = 'NotAllowedError';

  assert.match(microphoneAccessErrorMessage(error), /إذن الميكروفون مرفوض/);
  assert.match(speechRecognitionErrorMessage('not-allowed') ?? '', /إذن الميكروفون مرفوض/);
});

test('voice input distinguishes missing hardware, no speech, and network failures', () => {
  const missingMicrophone = new Error('No device');
  missingMicrophone.name = 'NotFoundError';

  assert.match(microphoneAccessErrorMessage(missingMicrophone), /لم أجد ميكروفوناً/);
  assert.match(speechRecognitionErrorMessage('no-speech') ?? '', /لم أسمع كلاماً واضحاً/);
  assert.match(speechRecognitionErrorMessage('network') ?? '', /خدمة تحويل الصوت/);
});

test('voice input ignores expected abort events and keeps existing composer text', () => {
  assert.equal(speechRecognitionErrorMessage('aborted'), null);
  assert.equal(appendVoiceTranscript('حلل الحساب', 'آخر 30 يوم'), 'حلل الحساب آخر 30 يوم');
  assert.equal(appendVoiceTranscript('', 'أوقف الهدر'), 'أوقف الهدر');
});

test('voice input stops microphone tracks after a successful permission check', async () => {
  let stopped = false;

  await requestMicrophoneAccess(async () => ({
    getTracks: () => [{ stop: () => (stopped = true) }],
  }));

  assert.equal(stopped, true);
});

test('voice input times out instead of leaving the composer stuck', async () => {
  await assert.rejects(
    requestMicrophoneAccess(() => new Promise(() => undefined), 5),
    (error: unknown) => {
      assert.equal(error instanceof Error ? error.name : '', 'MicrophoneTimeoutError');
      assert.match(microphoneAccessErrorMessage(error), /لم يصل رد من المتصفح/);
      return true;
    }
  );
});
