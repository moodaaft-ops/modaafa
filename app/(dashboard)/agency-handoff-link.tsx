'use client';

export function AgencyHandoffLink({ href, customerId, label }: { href: string; customerId: string; label: string }) {
  function record() {
    // Fire and forget: the WhatsApp tab must open whether or not this lands.
    try {
      void fetch('/api/handoff/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId }),
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // ignore
    }
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={record}
      className="mt-3 inline-flex min-h-10 items-center rounded-md bg-foreground px-4 text-sm font-semibold text-background"
    >
      {label}
    </a>
  );
}
