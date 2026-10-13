/**
 * WhatsApp wants the number as plain digits with the country code and no plus
 * sign ("966554235720"). The platform stores phones as E.164 with a plus in
 * users.phone_normalized, and users type them every way imaginable, so this
 * is the one place that turns any of those into the WhatsApp form.
 *
 * Returns null instead of guessing when the input cannot be a real number.
 */
export function toWhatsAppId(input: string | null | undefined): string | null {
  if (!input) return null;

  // Arabic-Indic and Persian digits show up when people type on an Arabic keyboard.
  const ascii = input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

  const trimmed = ascii.trim();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  let normalized: string;
  if (trimmed.startsWith('00')) {
    normalized = digits.slice(2);
  } else if (international) {
    normalized = digits;
  } else if (/^05\d{8}$/.test(digits)) {
    // Saudi local mobile, the format most users type.
    normalized = `966${digits.slice(1)}`;
  } else if (/^5\d{8}$/.test(digits)) {
    normalized = `966${digits}`;
  } else {
    normalized = digits;
  }

  // E.164: country code never starts with 0, 8 to 15 digits in total.
  return /^[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
