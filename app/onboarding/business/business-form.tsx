'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PendingSubmitButton } from '@/lib/ui/pending-submit-button';
import { buttonClasses } from '@/lib/ui/button';
import { Alert } from '@/lib/ui/alert';
import { Field, inputClasses } from '@/lib/ui/field';
import {
  normalizeWebsiteInput,
  validateBusinessForm,
  type BusinessFormErrors,
  type BusinessFormField,
  type BusinessFormValues,
} from '@/lib/onboarding/business-form';

const goals = [
  { value: 'leads', label: 'عملاء محتملون' },
  { value: 'conversions', label: 'مبيعات وتحويلات' },
  { value: 'traffic', label: 'زيارات مؤهلة' },
  { value: 'awareness', label: 'انتشار ووعي' },
];

/** Field order for focusing the first problem. */
const FIELD_ORDER: BusinessFormField[] = ['name', 'sector', 'website', 'monthly_budget', 'primary_goal', 'target_regions'];

const DRAFT_KEY = 'modaafa:onboarding-business-draft';

function readDraft(): BusinessFormValues | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BusinessFormValues>;
    return {
      name: String(parsed.name ?? ''),
      sector: String(parsed.sector ?? ''),
      website: String(parsed.website ?? ''),
      monthly_budget: String(parsed.monthly_budget ?? ''),
      primary_goal: String(parsed.primary_goal ?? 'leads'),
      target_regions: String(parsed.target_regions ?? ''),
    };
  } catch {
    return null;
  }
}

function writeDraft(values: BusinessFormValues | null) {
  try {
    if (values) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(values));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage blocked: the server-side defaults still refill most fields.
  }
}

export function BusinessForm({
  initial,
  serverError,
  canLeave,
}: {
  initial: BusinessFormValues;
  serverError: string | null;
  canLeave: boolean;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<BusinessFormValues>(initial);
  const [errors, setErrors] = useState<BusinessFormErrors>({});
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // A server-side rejection reloads the page. Put back what the user typed
  // instead of the last saved profile, so nothing has to be typed twice.
  useEffect(() => {
    if (!serverError) {
      writeDraft(null);
      return;
    }
    const draft = readDraft();
    if (draft) {
      setValues(draft);
      setErrors(validateBusinessForm(draft));
    }
  }, [serverError]);

  // Capture phase on the form itself, so a blocked submit is cancelled before
  // PendingSubmitButton's own listener decides the form is on its way.
  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onSubmit = (event: SubmitEvent) => {
      const current = { ...valuesRef.current, website: normalizeWebsiteInput(valuesRef.current.website) };
      const found = validateBusinessForm(current);
      if (Object.keys(found).length > 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setErrors(found);
        const first = FIELD_ORDER.find((field) => found[field]);
        if (first) form.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
        return;
      }
      const websiteInput = form.querySelector<HTMLInputElement>('[name="website"]');
      if (websiteInput) websiteInput.value = current.website;
      writeDraft(current);
    };
    form.addEventListener('submit', onSubmit, true);
    return () => form.removeEventListener('submit', onSubmit, true);
  }, []);

  const update = (field: BusinessFormField) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = { ...values, [field]: event.target.value };
    setValues(next);
    if (errors[field]) {
      const remaining = validateBusinessForm(next);
      setErrors((prev) => ({ ...prev, [field]: remaining[field] }));
    }
  };

  const blurWebsite = () => {
    const normalized = normalizeWebsiteInput(values.website);
    const next = { ...values, website: normalized };
    setValues(next);
    setErrors((prev) => ({ ...prev, website: validateBusinessForm(next).website }));
  };

  return (
    <form
      ref={formRef}
      action="/api/onboarding/business"
      method="post"
      noValidate
      className="surface-card p-5 sm:p-6"
    >
      {serverError && (
        <div className="mb-5">
          <Alert tone="danger">{serverError}</Alert>
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="اسم النشاط" required error={errors.name}>
          <input
            name="name"
            value={values.name}
            onChange={update('name')}
            className={inputClasses}
            placeholder="مثلاً: عيادة، متجر، شركة خدمات"
            aria-invalid={Boolean(errors.name)}
            maxLength={160}
          />
        </Field>

        <Field label="المجال">
          <input
            name="sector"
            value={values.sector}
            onChange={update('sector')}
            className={inputClasses}
            placeholder="صحة، تجارة إلكترونية، عقار"
          />
        </Field>

        <Field label="الموقع الإلكتروني" hint="نضيف https تلقائياً" error={errors.website}>
          <input
            name="website"
            value={values.website}
            onChange={update('website')}
            onBlur={blurWebsite}
            className={inputClasses}
            placeholder="example.com"
            dir="ltr"
            inputMode="url"
            autoComplete="url"
            aria-invalid={Boolean(errors.website)}
          />
        </Field>

        <Field label="الميزانية الشهرية التقريبية" hint="بالريال السعودي" error={errors.monthly_budget}>
          <input
            name="monthly_budget"
            value={values.monthly_budget}
            onChange={update('monthly_budget')}
            className={inputClasses}
            inputMode="numeric"
            dir="ltr"
            aria-invalid={Boolean(errors.monthly_budget)}
          />
        </Field>
      </div>

      <fieldset className="mt-6">
        <legend className="mb-2 text-[13px] font-medium text-foreground">الهدف الأساسي</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {goals.map((goal) => (
            <label
              key={goal.value}
              className="flex cursor-pointer items-center gap-2.5 border border-border bg-background-elevated px-3.5 py-3 text-[13px] transition-colors duration-150 hover:border-border-strong has-[:checked]:border-foreground has-[:checked]:font-semibold"
            >
              <input
                type="radio"
                name="primary_goal"
                value={goal.value}
                checked={values.primary_goal === goal.value}
                onChange={() => setValues({ ...values, primary_goal: goal.value })}
                className="h-4 w-4 accent-primary"
              />
              <span>{goal.label}</span>
            </label>
          ))}
        </div>
        {errors.primary_goal && (
          <p className="mt-2 text-xs font-medium text-danger" role="alert">
            {errors.primary_goal}
          </p>
        )}
      </fieldset>

      <div className="mt-6">
        <Field label="المدن أو المناطق المستهدفة" hint="افصل بينها بفاصلة">
          <input
            name="target_regions"
            value={values.target_regions}
            onChange={update('target_regions')}
            className={inputClasses}
            placeholder="الرياض، جدة، الدمام"
          />
        </Field>
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5">
        {canLeave && (
          <a href="/dashboard" className={buttonClasses({ variant: 'ghost' })}>
            إلغاء
          </a>
        )}
        <PendingSubmitButton pendingLabel="جاري حفظ النشاط..." className={buttonClasses({ variant: 'primary', size: 'lg' })}>
          التالي: ربط Google Ads
          <ArrowLeft className="h-4 w-4" />
        </PendingSubmitButton>
      </div>
    </form>
  );
}
