import { MessageCircle } from 'lucide-react';
import { requireOperatorPage, contactHref } from '@/lib/platform/operator-page';
import {
  FOLLOWUP_STATUS_LABEL,
  leadWhatsappText,
  loadLeadsDataset,
  type AgencyLeadView,
  type LeadView,
} from '@/lib/platform/operator-leads';
import { GROWTH_OWNER_CONFIG, exitPopupEnabled } from '@/lib/growth/owner-config';
import {
  ACCOUNT_MANAGERS,
  BUSINESS_TYPES,
  SPEND_BANDS,
  labelFor,
} from '@/lib/growth/onboarding-answers';
import { LEAD_FOLLOWUP } from '@/config/lead-followup';
import { formatNumberAr, timeAgoAr } from '@/lib/utils';
import { ContactButton, OpsTabs, SectionHead } from '../ops-ui';
import { riyadhTime } from '../format';

export const metadata = { title: 'الفرص | مركز التشغيل' };
export const dynamic = 'force-dynamic';

const AGENCY_MESSAGE =
  'هلا، أنا أيمن من مُضاعِف. شفت إن حسابك الإعلاني يصرف مبلغ محترم، وودي أعرف لو تحب فريقنا يتولى إدارته عنك. تبي نتكلم خمس دقايق؟';

export default async function OperationsLeadsPage({
  searchParams,
}: {
  searchParams?: Promise<{ ok?: string; error?: string }>;
}) {
  await requireOperatorPage('/operations/leads');
  const flags = await searchParams;
  const now = Date.now();
  const data = await loadLeadsDataset();
  const rule = GROWTH_OWNER_CONFIG.agencyLeadMinSpendBand;
  const whatsappLeads = data.leads.filter((lead) => lead.channel === 'whatsapp');
  const emailLeads = data.leads.filter((lead) => lead.channel === 'email');
  const waitingWhatsapp = whatsappLeads.filter((lead) => lead.whatsappStatus === 'pending' && !lead.alreadyUser);
  const text = leadWhatsappText(GROWTH_OWNER_CONFIG.sampleReportUrl);

  return (
    <div className="pb-16">
      <header className="px-4 pb-2 pt-5 sm:px-6 lg:px-8">
        <h1 className="text-lg font-bold text-foreground">الفرص</h1>
        <p className="mt-0.5 text-[13px] text-muted-foreground">زوار تركوا بياناتهم، ومسجلون يستاهلون مكالمة · للمالك فقط</p>
      </header>
      <OpsTabs active="leads" updatedAt={riyadhTime(now)} />

      <div className="space-y-10 px-4 pt-6 sm:px-6 lg:px-8">
        {flags?.error && (
          <p role="alert" className="border border-danger/40 bg-danger/10 px-4 py-3 text-[13px] text-foreground">
            ما انحفظ التغيير. جرّب مرة ثانية.
          </p>
        )}
        <Notices
          popup={exitPopupEnabled()}
          followupApproved={LEAD_FOLLOWUP.approved}
          sampleSet={Boolean(GROWTH_OWNER_CONFIG.sampleReportUrl)}
          leadsUnavailable={data.leadsUnavailable}
          agencyUnavailable={data.agencyUnavailable}
        />

        {/* Agency leads */}
        <section aria-labelledby="agency-title">
          <SectionHead
            id="agency-title"
            title="مرشحون للإدارة الكاملة"
            note={
              rule
                ? `صرفهم الشهري في شريحة «${labelFor(SPEND_BANDS, rule) ?? ''}» أو أعلى، وجاوبوا إن ما أحد يدير حسابهم.`
                : 'الكليد مخفي لين تحدد حد الصرف في lib/growth/owner-config.ts.'
            }
            aside={<span className="text-sm font-semibold numeric text-foreground">{formatNumberAr(data.agency.length)}</span>}
          />
          {data.agency.length === 0 ? (
            <p className="mt-4 border border-border px-4 py-6 text-sm text-muted-foreground">
              {rule
                ? `جاوب ${formatNumberAr(data.answeredCount)} مسجل على الأسئلة، وما فيه أحد منهم يطابق الشرط الحين.`
                : `${formatNumberAr(data.answeredCount)} مسجل جاوب على الأسئلة، وما نعلّم منهم أحد قبل ما تحدد الحد.`}
            </p>
          ) : (
            <ol className="mt-4 divide-y divide-border border-y border-border">
              {data.agency.map((item) => (
                <AgencyRow key={item.userId} item={item} />
              ))}
            </ol>
          )}
        </section>

        {/* WhatsApp list */}
        <section aria-labelledby="wa-title">
          <SectionHead
            id="wa-title"
            title="طلبوا النموذج على الواتساب"
            note="الواتساب ما ينرسل من السيرفر، فهذي قائمتك. الأرقام كتبها الزائر بنفسه وما تحققنا منها، فخلك مهذب في أول رسالة. اضغط الزر، أرسل، وبعدها علّمه «تم»."
            aside={<span className="text-sm font-semibold numeric text-foreground">{formatNumberAr(waitingWhatsapp.length)} ينتظرون</span>}
          />
          {whatsappLeads.length === 0 ? (
            <p className="mt-4 border border-border px-4 py-6 text-sm text-muted-foreground">ما وصل أحد بعد.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border border-y border-border">
              {whatsappLeads.map((lead) => (
                <WhatsappRow key={lead.id} lead={lead} text={text} now={now} />
              ))}
            </ul>
          )}
        </section>

        {/* Email list */}
        <section aria-labelledby="email-title">
          <SectionHead
            id="email-title"
            title="طلبوا النموذج على الإيميل"
            note="الإيميل ينرسل تلقائياً بعد ما توافق على النص."
            aside={<span className="text-sm font-semibold numeric text-foreground">{formatNumberAr(emailLeads.length)}</span>}
          />
          {emailLeads.length === 0 ? (
            <p className="mt-4 border border-border px-4 py-6 text-sm text-muted-foreground">ما وصل أحد بعد.</p>
          ) : (
            <ul className="mt-4 divide-y divide-border border-y border-border">
              {emailLeads.map((lead) => (
                <li key={lead.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground" dir="ltr">{lead.contact}</div>
                    <div className="text-xs text-muted-foreground">{timeAgoAr(lead.createdAt)}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {lead.alreadyUser && <Chip>مسجل عندنا</Chip>}
                    {lead.optedOut && <Chip>أوقف الرسائل</Chip>}
                    <Chip strong>{followupLabel(lead)}</Chip>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function followupLabel(lead: LeadView) {
  if (lead.followupStatus === 'pending' && !LEAD_FOLLOWUP.approved) return 'ينتظر موافقتك على النص';
  if (lead.followupStatus === 'skipped' && lead.followupReason === 'already_user') return 'مسجل، ما نرسل له';
  return FOLLOWUP_STATUS_LABEL[lead.followupStatus] ?? lead.followupStatus;
}

function Chip({ children, strong = false }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <span className={strong ? 'border border-border-strong px-2 py-0.5 font-semibold text-foreground' : 'border border-border px-2 py-0.5 text-muted-foreground'}>
      {children}
    </span>
  );
}

function AgencyRow({ item }: { item: AgencyLeadView }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0">
        <div className="font-medium text-foreground" dir="ltr">{item.email}</div>
        <div className="text-xs text-muted-foreground">
          {[item.name, labelFor(BUSINESS_TYPES, item.businessType), labelFor(SPEND_BANDS, item.spendBand), labelFor(ACCOUNT_MANAGERS, item.accountManager)]
            .filter(Boolean)
            .join('، ')}
        </div>
      </div>
      <ContactButton profile={{ phone: item.phone, email: item.email }} text={AGENCY_MESSAGE} />
    </li>
  );
}

function WhatsappRow({ lead, text, now }: { lead: LeadView; text: string; now: number }) {
  const contact = contactHref({ phone: lead.contact, email: '' }, text);
  const done = lead.whatsappStatus !== 'pending';
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0">
        <div className="font-medium text-foreground numeric" dir="ltr">{lead.contact}</div>
        <div className="text-xs text-muted-foreground">
          {timeAgoAr(lead.createdAt)}
          {lead.alreadyUser ? ' · مسجل عندنا' : ''}
          {lead.whatsappStatus === 'contacted' && lead.contactedAt ? ` · تم التواصل ${timeAgoAr(lead.contactedAt)}` : ''}
          {lead.whatsappStatus === 'dismissed' ? ' · تم التجاهل' : ''}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {contact && !done && (
          <a
            href={contact.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1.5 border border-border-strong px-2.5 text-xs font-semibold text-foreground hover:border-foreground hover:bg-surface"
          >
            <MessageCircle className="h-3.5 w-3.5" aria-hidden />
            واتساب برسالة جاهزة
          </a>
        )}
        <form method="post" action="/api/operations/leads" className="flex gap-2">
          <input type="hidden" name="id" value={lead.id} />
          {done ? (
            <button name="to" value="reopen" className="h-8 border border-border px-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground">
              رجّعه للقائمة
            </button>
          ) : (
            <>
              <button name="to" value="contacted" className="h-8 border border-border-strong px-2.5 text-xs font-semibold text-foreground hover:bg-surface">
                تم
              </button>
              <button name="to" value="dismissed" className="h-8 border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground">
                تجاهل
              </button>
            </>
          )}
        </form>
      </div>
    </li>
  );
}

function Notices({
  popup,
  followupApproved,
  sampleSet,
  leadsUnavailable,
  agencyUnavailable,
}: {
  popup: boolean;
  followupApproved: boolean;
  sampleSet: boolean;
  leadsUnavailable: boolean;
  agencyUnavailable: boolean;
}) {
  const notes: React.ReactNode[] = [];
  if (leadsUnavailable) {
    notes.push(
      <span key="leads">
        جدول الزوار ما انشغل بعد: شغّل <code className="font-mono text-xs" dir="ltr">db/migrations/20261014_visitor_leads.sql</code> على Supabase.
      </span>
    );
  }
  if (agencyUnavailable) {
    notes.push(
      <span key="agency">
        جدول إجابات أول دخول ما انشغل بعد: شغّل <code className="font-mono text-xs" dir="ltr">db/migrations/20261014_user_onboarding_answers.sql</code>.
      </span>
    );
  }
  if (!popup) {
    notes.push(
      <span key="popup">
        نافذة الخروج مخفية على الموقع
        {!sampleSet ? '، لأن رابط نموذج التقرير ما انحط في owner-config' : ''}
        {!followupApproved ? '، ولأن نص الإيميل ما انوافق عليه في config/lead-followup.ts' : ''}.
      </span>
    );
  }
  if (notes.length === 0) return null;
  return (
    <div className="space-y-2">
      {notes.map((note, index) => (
        <p key={index} className="border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] leading-6 text-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}
