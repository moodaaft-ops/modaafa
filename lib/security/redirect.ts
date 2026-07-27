export function safeLocalPath(value: string | null | undefined, fallback = '/dashboard') {
  const candidate = value?.trim();
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, 'https://local.modaafa.invalid');
    if (parsed.origin !== 'https://local.modaafa.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
