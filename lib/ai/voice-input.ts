export type VoiceInputErrorCode =
  | 'aborted'
  | 'audio-capture'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'network'
  | 'no-speech'
  | 'not-allowed'
  | 'service-not-allowed'
  | string;

const SPEECH_ERROR_MESSAGES: Record<string, string> = {
  'audio-capture': 'لم أتمكن من الوصول إلى الميكروفون. تأكد أنه متصل وغير مستخدم في تطبيق آخر.',
  'language-not-supported': 'الإملاء العربي غير متاح في هذا المتصفح حالياً. جرّب أحدث إصدار من Chrome.',
  network: 'تعذر الوصول إلى خدمة تحويل الصوت في Chrome. تحقق من الإنترنت ثم أعد المحاولة.',
  'no-speech': 'لم أسمع كلاماً واضحاً. قرّب الميكروفون وتكلم ثم أعد المحاولة.',
  'not-allowed': 'إذن الميكروفون مرفوض. افتح إعدادات الموقع من رمز القفل واسمح بالميكروفون ثم أعد المحاولة.',
  'service-not-allowed':
    'خدمة الإملاء الصوتي محظورة في المتصفح. اسمح بالميكروفون وخدمة التعرف على الصوت ثم أعد المحاولة.',
};

const MICROPHONE_ERROR_MESSAGES: Record<string, string> = {
  AbortError: 'توقف طلب الميكروفون قبل اكتماله. أعد المحاولة.',
  NotAllowedError:
    'إذن الميكروفون مرفوض. افتح إعدادات الموقع من رمز القفل واسمح بالميكروفون ثم أعد المحاولة.',
  NotFoundError: 'لم أجد ميكروفوناً متاحاً على الجهاز. وصّل ميكروفوناً ثم أعد المحاولة.',
  NotReadableError: 'الميكروفون مستخدم في تطبيق آخر أو تعذر تشغيله. أغلق التطبيق الآخر ثم أعد المحاولة.',
  OverconstrainedError: 'تعذر تشغيل الميكروفون بالإعدادات الحالية. اختر ميكروفوناً آخر من إعدادات المتصفح.',
  SecurityError: 'المتصفح منع الوصول إلى الميكروفون لأسباب أمنية. تأكد أنك تستخدم اتصالاً آمناً.',
  MicrophoneTimeoutError:
    'لم يصل رد من المتصفح على إذن الميكروفون. افتح إعدادات الموقع من رمز القفل، اسمح بالميكروفون، ثم أعد المحاولة.',
};

type MicrophoneStream = {
  getTracks(): Array<{ stop(): void }>;
};

export function speechRecognitionErrorMessage(code: VoiceInputErrorCode): string | null {
  if (code === 'aborted') return null;
  return SPEECH_ERROR_MESSAGES[code] ?? 'تعذر تحويل الصوت إلى نص. أعد المحاولة أو اكتب رسالتك.';
}

export function microphoneAccessErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  return MICROPHONE_ERROR_MESSAGES[name] ?? 'تعذر تشغيل الميكروفون. تحقق من صلاحيته ثم أعد المحاولة.';
}

export function appendVoiceTranscript(base: string, transcript: string): string {
  return [base.trim(), transcript.trim()].filter(Boolean).join(' ');
}

export async function requestMicrophoneAccess(
  request: () => Promise<MicrophoneStream>,
  timeoutMs = 12_000
): Promise<void> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const accessRequest = request().then((stream) => {
    if (timedOut) stream.getTracks().forEach((track) => track.stop());
    return stream;
  });
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      const error = new Error('Microphone permission prompt timed out');
      error.name = 'MicrophoneTimeoutError';
      reject(error);
    }, timeoutMs);
  });

  try {
    const stream = await Promise.race([accessRequest, timeout]);
    stream.getTracks().forEach((track) => track.stop());
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
