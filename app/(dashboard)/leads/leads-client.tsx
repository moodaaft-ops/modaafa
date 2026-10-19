'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, Search } from 'lucide-react';
import { extractRefCode } from '@/lib/lead-loop/ref-code';
import { Alert } from '@/lib/ui/alert';
import { Button } from '@/lib/ui/button';
import { Field, inputClasses, textareaClasses } from '@/lib/ui/field';
import { StatusBadge, type StatusTone } from '@/lib/ui/status-badge';
import { cn, timeAgoAr } from '@/lib/utils';

type Lead = {
  id: string;
  refCode: string;
  clickedAt: string;
  status: string;
  valueSar: number | null;
  source: string | null;
  campaign: string | null;
  term: string | null;
  uploadStatus: string;
  hasClickId: boolean;
};

type LinkSettings = { whatsappNumber: string; defaultText: string; link: string; snippet: string } | null;
type Summary = { total: number; customers: number; value_sar: number; waiting: number };

const STATUS_LABEL: Record<string, { text: string; tone: StatusTone }> = {
  new: { text: 'جديد', tone: 'info' },
  customer: { text: 'زبون', tone: 'success' },
  no_reply: { text: 'ما رد', tone: 'neutral' },
  not_serious: { text: 'مو جاد', tone: 'warning' },
};

const UPLOAD_LABEL: Record<string, string> = {
  pending: 'ينرفع لقوقل',
  uploading: 'ينرفع لقوقل',
  uploaded: 'انرفع لقوقل',
  failed: 'ما انرفع، بنعيد المحاولة',
  skipped: 'ما ينرفع (ما فيه معرّف ضغطة)',
};

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 2000);
    } catch {
      setCopied(null);
    }
  }
  return { copied, copy };
}

export function LeadsClient({
  customerId,
  settings,
  leads,
  summary,
  windowDays,
}: {
  customerId: string;
  settings: LinkSettings;
  leads: Lead[];
  summary: Summary;
  windowDays: number;
}) {
  const router = useRouter();
  const { copied, copy } = useCopy();
  const [number, setNumber] = useState(settings?.whatsappNumber ?? '');
  const [text, setText] = useState(settings?.defaultText || 'السلام عليكم، أبي أستفسر');
  const [link, setLink] = useState(settings?.link ?? null);
  const [snippet, setSnippet] = useState(settings?.snippet ?? null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [find, setFind] = useState('');
  const [marking, setMarking] = useState<string | null>(null);
  const [valueFor, setValueFor] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [markError, setMarkError] = useState<string | null>(null);

  const foundRef = find.trim() ? extractRefCode(find) : null;
  const visible = useMemo(() => {
    if (!find.trim()) return leads;
    if (!foundRef) return [];
    return leads.filter((lead) => lead.refCode === foundRef);
  }, [leads, find, foundRef]);

  async function saveSettings() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const response = await fetch('/api/leads/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId, whatsapp_number: number, default_text: text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSaveMsg({ tone: 'danger', text: data.message ?? 'ما انحفظ، جرب مرة ثانية' });
        return;
      }
      setLink(data.link);
      setSnippet(data.snippet);
      setSaveMsg({ tone: 'success', text: 'انحفظ. انسخ الرابط وحطه في زر الواتساب.' });
      router.refresh();
    } catch {
      setSaveMsg({ tone: 'danger', text: 'ما انحفظ، تأكد من النت وجرب مرة ثانية' });
    } finally {
      setSaving(false);
    }
  }

  async function mark(lead: Lead, status: 'customer' | 'no_reply' | 'not_serious', valueSar?: string) {
    setMarking(lead.id);
    setMarkError(null);
    try {
      const response = await fetch('/api/leads/mark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId, lead_id: lead.id, status, value_sar: valueSar ?? null }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMarkError(data.message ?? 'ما انحفظ، جرب مرة ثانية');
        return;
      }
      setValueFor(null);
      setValue('');
      router.refresh();
    } catch {
      setMarkError('ما انحفظ، تأكد من النت وجرب مرة ثانية');
    } finally {
      setMarking(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6" dir="rtl">
      <section className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="ملخص الأسبوع">
        <Stat label={`ضغطات آخر ${windowDays} أيام`} value={summary.total} />
        <Stat label="صاروا زبائن" value={summary.customers} />
        <Stat label="ينتظرون تعليمك" value={summary.waiting} />
      </section>

      <section className="space-y-3 border border-border bg-card p-4" aria-label="رابط الواتساب الذكي">
        <h2 className="text-base font-semibold">رابط الواتساب الذكي</h2>
        <p className="text-sm text-muted-foreground">
          حط هذا الرابط مكان رابط الواتساب في موقعك. كل ضغطة تجيب كود قصير (مثل M-7K2Q) يوصل لك داخل الرسالة، وبه تعرف مين صار زبون.
        </p>
        <Field label="رقم الواتساب" hint="مثال: 0551234567">
          <input
            className={inputClasses}
            inputMode="tel"
            dir="ltr"
            value={number}
            onChange={(event) => setNumber(event.target.value)}
            placeholder="05xxxxxxxx"
          />
        </Field>
        <Field label="نص الرسالة" hint="الكود يضاف له تلقائي">
          <textarea className={textareaClasses} rows={2} value={text} onChange={(event) => setText(event.target.value)} maxLength={200} />
        </Field>
        <Button onClick={saveSettings} loading={saving} loadingLabel="يحفظ" block className="sm:w-auto">
          حفظ
        </Button>
        {saveMsg && <Alert tone={saveMsg.tone}>{saveMsg.text}</Alert>}

        {link && (
          <div className="space-y-3 pt-2">
            <CopyRow label="رابطك" value={link} copied={copied === 'link'} onCopy={() => copy('link', link)} />
            {snippet && (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">كود يحفظ معرّف الضغطة (يلصقه المطور مرة وحدة)</summary>
                <p className="mt-2 text-muted-foreground">
                  بدونه الرابط يشتغل، لكن قوقل ما يقدر يربط الزبون بإعلانه. يعني ما تنرفع الزبائن لقوقل.
                </p>
                <CopyRow label="الكود" value={snippet} copied={copied === 'snippet'} onCopy={() => copy('snippet', snippet)} multiline />
              </details>
            )}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="الليدز">
        <h2 className="text-base font-semibold">ليدز هالأسبوع</h2>
        <Field label="دور بكود" hint="الصق الكود أو الرسالة كلها">
          <div className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              className={cn(inputClasses, 'ps-9')}
              value={find}
              onChange={(event) => setFind(event.target.value)}
              placeholder="M-7K2Q"
            />
          </div>
        </Field>

        {markError && <Alert tone="danger">{markError}</Alert>}

        {visible.length === 0 ? (
          <p className="border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {find.trim()
              ? foundRef
                ? 'ما لقينا هالكود في ليدز هالأسبوع'
                : 'ما قدرنا نقرأ كود من اللي لصقته'
              : 'ما فيه ضغطات للحين. أول ما أحد يضغط على الرابط يطلع هنا.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {visible.map((lead) => {
              const label = STATUS_LABEL[lead.status] ?? STATUS_LABEL.new;
              const busy = marking === lead.id;
              const locked = lead.uploadStatus === 'uploaded';
              return (
                <li key={lead.id} className="space-y-3 border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-semibold" dir="ltr">{lead.refCode}</span>
                    <StatusBadge tone={label.tone}>{label.text}</StatusBadge>
                    {lead.valueSar !== null && <span className="text-sm">{lead.valueSar} ريال</span>}
                    <span className="ms-auto text-xs text-muted-foreground">{timeAgoAr(lead.clickedAt)}</span>
                  </div>
                  {(lead.campaign || lead.term || lead.source) && (
                    <p className="text-xs text-muted-foreground">
                      {[lead.campaign, lead.term, lead.source].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {UPLOAD_LABEL[lead.uploadStatus] && <p className="text-xs text-muted-foreground">{UPLOAD_LABEL[lead.uploadStatus]}</p>}
                  {!locked && (
                    <div className="flex flex-wrap gap-2">
                      {valueFor === lead.id ? (
                        <div className="flex w-full flex-wrap items-end gap-2">
                          <Field label="قيمة البيع بالريال" hint="اختياري" className="min-w-[10rem] flex-1">
                            <input
                              className={inputClasses}
                              inputMode="decimal"
                              dir="ltr"
                              value={value}
                              onChange={(event) => setValue(event.target.value)}
                              placeholder="500"
                            />
                          </Field>
                          <Button size="md" loading={busy} loadingLabel="يحفظ" onClick={() => mark(lead, 'customer', value)}>
                            <Check className="h-4 w-4" aria-hidden />
                            تأكيد
                          </Button>
                          <Button size="md" variant="ghost" onClick={() => setValueFor(null)}>
                            إلغاء
                          </Button>
                        </div>
                      ) : (
                        <>
                          <Button size="md" disabled={busy} onClick={() => { setValueFor(lead.id); setValue(lead.valueSar?.toString() ?? ''); }}>
                            صار زبون
                          </Button>
                          <Button size="md" variant="outline" disabled={busy} onClick={() => mark(lead, 'no_reply')}>
                            ما رد
                          </Button>
                          <Button size="md" variant="outline" disabled={busy} onClick={() => mark(lead, 'not_serious')}>
                            مو جاد
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border bg-card p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function CopyRow({
  label,
  value,
  copied,
  onCopy,
  multiline,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  multiline?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[13px] font-medium">{label}</div>
      <div className="flex items-start gap-2">
        {multiline ? (
          <textarea readOnly dir="ltr" rows={4} className={cn(textareaClasses, 'font-mono text-xs')} value={value} onFocus={(event) => event.currentTarget.select()} />
        ) : (
          <input readOnly dir="ltr" className={inputClasses} value={value} onFocus={(event) => event.currentTarget.select()} />
        )}
        <Button variant="outline" size="md" onClick={onCopy} aria-label={`نسخ ${label}`}>
          {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
          {copied ? 'اننسخ' : 'نسخ'}
        </Button>
      </div>
    </div>
  );
}
