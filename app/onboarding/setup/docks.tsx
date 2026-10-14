'use client';

import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Briefcase,
  Building2,
  Check,
  Clock,
  Coins,
  Flag,
  Globe,
  GraduationCap,
  HelpCircle,
  Map,
  MapPin,
  Megaphone,
  MoreHorizontal,
  Pencil,
  Phone,
  PowerOff,
  Rocket,
  Search,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Stethoscope,
  Store,
  TrendingDown,
  User,
  UserCog,
  Users,
  UtensilsCrossed,
} from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import {
  CITY_OPTIONS,
  CONSENT_OPTIONS,
  GOAL_OPTIONS,
  MANAGER_OPTIONS,
  NAME_MAX,
  PAIN_OPTIONS,
  REGION_OPTIONS,
  TYPE_OPTIONS,
  VALUE_OPTIONS,
  budgetChoices,
  formatAmount,
  normalizeWebsite,
  parseAmount,
  type IconKey,
  type SetupKey,
  type SetupOption,
} from '@/lib/setup/questions';
import type { SetupAccount, SetupState } from '@/lib/setup/load';
import { foldArabicSearch, toAsciiDigits } from '@/lib/accounts/search';

/** The question bank's icons, plus the two arrows the adaptive docks use for «أقل» and «أكثر». */
export type TileIcon = IconKey | 'arrow-up' | 'arrow-down';

const ICONS: Record<TileIcon, React.ComponentType<{ className?: string }>> = {
  'arrow-up': ArrowUp,
  'arrow-down': ArrowDown,
  bag: ShoppingBag,
  briefcase: Briefcase,
  store: Store,
  health: Stethoscope,
  building: Building2,
  food: UtensilsCrossed,
  school: GraduationCap,
  dots: MoreHorizontal,
  cart: ShoppingCart,
  phone: Phone,
  pin: MapPin,
  globe: Globe,
  megaphone: Megaphone,
  user: User,
  users: Users,
  badge: UserCog,
  off: PowerOff,
  'trend-down': TrendingDown,
  coins: Coins,
  help: HelpCircle,
  rocket: Rocket,
  search: Search,
  map: Map,
  check: Check,
  shield: ShieldCheck,
  pencil: Pencil,
  clock: Clock,
  flag: Flag,
};

/** An icon name from the adaptive bank (a plain string) when it is one the docks know, else none. */
export function iconFor(name: string | undefined): TileIcon | undefined {
  return name && Object.prototype.hasOwnProperty.call(ICONS, name) ? (name as TileIcon) : undefined;
}

/** What a dock hands back: the payload for the API and the words for the customer's bubble. */
export type AnswerPayload = { answer: Record<string, any> & { choice?: string }; label: string };

export const inputClass =
  'h-14 w-full min-w-0 rounded-full border border-border bg-card px-5 text-[16px] text-foreground placeholder:text-muted-foreground focus:border-border-strong focus:outline-none';

export function AnswerTile({
  label,
  hint,
  icon,
  current = false,
  disabled = false,
  compact = false,
  onClick,
}: {
  label: string;
  hint?: string;
  icon?: TileIcon;
  current?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onClick: () => void;
}) {
  const Icon = icon ? ICONS[icon] : null;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={current || undefined}
      className={cn(
        'group flex w-full items-center gap-3 rounded-[16px] border bg-card px-4 text-start font-semibold text-foreground transition-colors duration-100',
        'hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        'active:bg-foreground active:text-background disabled:opacity-50',
        compact ? 'min-h-[52px] py-2.5 text-[14.5px]' : 'min-h-[56px] py-3 text-[15.5px]',
        current ? 'border-foreground' : 'border-border'
      )}
    >
      {Icon && <Icon className="h-5 w-5 flex-shrink-0 text-muted-foreground group-hover:text-foreground group-active:text-background" />}
      <span className="min-w-0 flex-1">
        <span className="block leading-6">{label}</span>
        {hint && <span className="block text-[12.5px] font-normal text-muted-foreground group-active:text-background/80">{hint}</span>}
      </span>
      {current && (
        <span className="flex flex-shrink-0 items-center gap-1 text-[12px] font-semibold text-muted-foreground">
          <Check className="h-3.5 w-3.5" />
          الحالي
        </span>
      )}
    </button>
  );
}

export function OptionList({
  options,
  current,
  columns = 1,
  busy,
  onPick,
}: {
  options: SetupOption[];
  current?: string | null;
  columns?: 1 | 2;
  busy: boolean;
  onPick: (option: SetupOption) => void;
}) {
  return (
    <div className={cn('grid gap-2', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}>
      {options.map((option) => (
        <AnswerTile
          key={option.id}
          label={option.label}
          hint={option.hint}
          icon={option.icon}
          compact={columns === 2}
          current={current === option.id}
          disabled={busy}
          onClick={() => onPick(option)}
        />
      ))}
    </div>
  );
}

export function TextAnswer({
  placeholder,
  initial = '',
  inputMode,
  dir,
  maxLength,
  busy,
  submitLabel = 'تم',
  validate,
  onSubmit,
}: {
  placeholder: string;
  initial?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  dir?: 'ltr' | 'rtl';
  maxLength: number;
  busy: boolean;
  submitLabel?: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        const problem = validate ? validate(trimmed) : trimmed.length < 2 ? 'اكتب كلمتين على الأقل' : null;
        if (problem) {
          setError(problem);
          return;
        }
        onSubmit(trimmed);
      }}
    >
      <div className="flex gap-2">
        <input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder={placeholder}
          inputMode={inputMode}
          dir={dir}
          maxLength={maxLength}
          aria-invalid={Boolean(error)}
          aria-label={placeholder}
          className={inputClass}
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="h-14 flex-shrink-0 rounded-full bg-primary px-6 text-[16px] font-bold text-primary-foreground disabled:opacity-40"
        >
          {submitLabel}
        </button>
      </div>
      {error && <p className="text-[13px] font-semibold text-danger">{error}</p>}
    </form>
  );
}

export function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="mt-2 inline-flex items-center gap-1.5 py-1.5 text-[13px] font-semibold text-muted-foreground hover:text-foreground"
    >
      <ArrowRight className="h-3.5 w-3.5" />
      رجوع للسؤال اللي قبل
    </button>
  );
}

export function QuestionDock({
  k,
  state,
  busy,
  canBack,
  onBack,
  onAnswer,
}: {
  k: SetupKey;
  state: SetupState;
  busy: boolean;
  canBack: boolean;
  onBack: () => void;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  const current = state.edit ? state.answered[k] ?? null : null;
  const body = (() => {
    switch (k) {
      case 'type':
        return <TypeDock current={current} busy={busy} onAnswer={onAnswer} />;
      case 'name':
        return <NameDock state={state} busy={busy} onAnswer={onAnswer} />;
      case 'goal':
        return (
          <OptionList
            options={GOAL_OPTIONS}
            current={current}
            busy={busy}
            onPick={(o) => onAnswer({ answer: { choice: o.id }, label: o.label })}
          />
        );
      case 'value':
        return (
          <OptionList
            options={VALUE_OPTIONS}
            current={current}
            busy={busy}
            onPick={(o) => onAnswer({ answer: { choice: o.id }, label: o.label })}
          />
        );
      case 'budget':
        return <BudgetDock state={state} busy={busy} onAnswer={onAnswer} />;
      case 'regions':
        return <RegionsDock state={state} current={current} busy={busy} onAnswer={onAnswer} />;
      case 'manager':
        return (
          <OptionList
            options={MANAGER_OPTIONS}
            current={current}
            busy={busy}
            onPick={(o) => onAnswer({ answer: { choice: o.id }, label: o.label })}
          />
        );
      case 'pain':
        return (
          <OptionList
            options={PAIN_OPTIONS}
            current={current}
            busy={busy}
            onPick={(o) => onAnswer({ answer: { choice: o.id }, label: o.label })}
          />
        );
      case 'website':
        return <WebsiteDock state={state} busy={busy} onAnswer={onAnswer} />;
      case 'consent':
        return (
          <OptionList
            options={CONSENT_OPTIONS}
            busy={busy}
            onPick={(o) => onAnswer({ answer: { choice: o.id }, label: o.label })}
          />
        );
    }
  })();
  return (
    <div>
      {body}
      {canBack && <BackLink onBack={onBack} />}
    </div>
  );
}

function TypeDock({
  current,
  busy,
  onAnswer,
}: {
  current: string | null;
  busy: boolean;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  const [other, setOther] = useState(false);
  if (other) {
    return (
      <div className="space-y-2">
        <TextAnswer
          placeholder="مثلاً: ورشة سيارات"
          maxLength={40}
          busy={busy}
          onSubmit={(text) => onAnswer({ answer: { choice: 'other', text }, label: text })}
        />
        <button type="button" onClick={() => setOther(false)} className="text-[13px] font-semibold text-muted-foreground">
          رجوع للخيارات
        </button>
      </div>
    );
  }
  return (
    <OptionList
      options={TYPE_OPTIONS}
      current={current}
      columns={2}
      busy={busy}
      onPick={(o) => (o.id === 'other' ? setOther(true) : onAnswer({ answer: { choice: o.id }, label: o.label }))}
    />
  );
}

function NameDock({ state, busy, onAnswer }: { state: SetupState; busy: boolean; onAnswer: (payload: AnswerPayload) => void }) {
  const prefill = state.edit ? state.business?.name ?? state.namePrefill : state.namePrefill;
  const [typing, setTyping] = useState(!prefill || state.edit);
  if (typing) {
    return (
      <TextAnswer
        placeholder="اسم نشاطك"
        initial={state.edit ? prefill ?? '' : ''}
        maxLength={NAME_MAX}
        busy={busy}
        onSubmit={(text) => onAnswer({ answer: { text }, label: text })}
      />
    );
  }
  return (
    <div className="grid gap-2">
      <AnswerTile
        label={`إيه، «${prefill}»`}
        icon="check"
        disabled={busy}
        onClick={() => onAnswer({ answer: { text: prefill ?? '' }, label: prefill ?? '' })}
      />
      <AnswerTile label="لا، اسمه غير" icon="pencil" disabled={busy} onClick={() => setTyping(true)} />
    </div>
  );
}

function BudgetDock({ state, busy, onAnswer }: { state: SetupState; busy: boolean; onAnswer: (payload: AnswerPayload) => void }) {
  const [typing, setTyping] = useState(false);
  const choices = useMemo(
    () => budgetChoices(state.edit ? null : state.selected?.spend30 ?? null, state.selected?.currency ?? 'SAR'),
    [state.edit, state.selected?.spend30, state.selected?.currency]
  );
  if (typing) {
    return (
      <div className="space-y-2">
        <TextAnswer
          placeholder="المبلغ بالريال، مثلاً 5000"
          inputMode="numeric"
          dir="ltr"
          maxLength={12}
          busy={busy}
          submitLabel="تم"
          validate={(value) => {
            const amount = parseAmount(value);
            return amount === 'invalid' || amount === null ? 'اكتب رقم بدون كسور، مثلاً 5000' : null;
          }}
          onSubmit={(value) => {
            const amount = parseAmount(value) as number;
            onAnswer({ answer: { amount }, label: `${formatAmount(amount)} ريال بالشهر` });
          }}
        />
        <button type="button" onClick={() => setTyping(false)} className="text-[13px] font-semibold text-muted-foreground">
          رجوع للخيارات
        </button>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      {state.edit && state.business?.monthlyBudget ? (
        <p className="text-[13px] text-muted-foreground">
          الحالي: <span className="numeric font-semibold text-foreground">{formatCurrency(state.business.monthlyBudget, 'SAR')}</span>
        </p>
      ) : null}
      {choices.map((choice) => (
        <AnswerTile
          key={choice.id}
          label={choice.label}
          icon={choice.icon}
          disabled={busy}
          onClick={() =>
            onAnswer({
              answer: { amount: choice.amount },
              label: choice.amount === null ? 'ما أدري' : `${formatAmount(choice.amount)} ريال بالشهر`,
            })
          }
        />
      ))}
      <AnswerTile label="أكتب رقم" icon="pencil" disabled={busy} onClick={() => setTyping(true)} />
    </div>
  );
}

function RegionsDock({
  state,
  current,
  busy,
  onAnswer,
}: {
  state: SetupState;
  current: string | null;
  busy: boolean;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  const known = (state.business?.targetRegions ?? []).filter((city) => (CITY_OPTIONS as readonly string[]).includes(city));
  const [picking, setPicking] = useState(false);
  const [cities, setCities] = useState<string[]>(state.edit ? known : []);
  const [custom, setCustom] = useState('');
  if (!picking) {
    return (
      <OptionList
        options={REGION_OPTIONS}
        current={current}
        busy={busy}
        onPick={(o) => (o.id === 'cities' ? setPicking(true) : onAnswer({ answer: { choice: o.id }, label: o.label }))}
      />
    );
  }
  const toggle = (city: string) =>
    setCities((list) => (list.includes(city) ? list.filter((c) => c !== city) : [...list, city]));
  const extra = custom.trim();
  const all = extra ? [...cities, extra] : cities;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="اختر المدن">
        {CITY_OPTIONS.map((city) => {
          const on = cities.includes(city);
          return (
            <button
              key={city}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(city)}
              className={cn(
                'min-h-[44px] rounded-full border px-4 text-[14.5px] font-semibold transition-colors',
                on ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-foreground hover:bg-muted'
              )}
            >
              {city}
            </button>
          );
        })}
      </div>
      <input
        value={custom}
        onChange={(event) => setCustom(event.target.value)}
        placeholder="مدينة ثانية؟ اكتبها هنا"
        maxLength={30}
        aria-label="مدينة ثانية"
        className={inputClass}
      />
      <button
        type="button"
        disabled={busy || all.length === 0}
        onClick={() => onAnswer({ answer: { choice: 'cities', cities: all }, label: all.join('، ') })}
        className="flex h-14 w-full items-center justify-center rounded-full bg-primary text-[16px] font-bold text-primary-foreground disabled:opacity-40"
      >
        {all.length === 0 ? 'اختر مدينة وحدة على الأقل' : `تم، ${all.length === 1 ? 'مدينة وحدة' : `${all.length} مدن`}`}
      </button>
    </div>
  );
}

function WebsiteDock({ state, busy, onAnswer }: { state: SetupState; busy: boolean; onAnswer: (payload: AnswerPayload) => void }) {
  return (
    <div className="space-y-2">
      <TextAnswer
        placeholder="mystore.com"
        initial={state.edit ? (state.business?.website ?? '').replace(/^https?:\/\//, '') : ''}
        inputMode="url"
        dir="ltr"
        maxLength={200}
        busy={busy}
        validate={(value) => (normalizeWebsite(value) ? null : 'الرابط ما ضبط. اكتبه مثل mystore.com')}
        onSubmit={(value) => onAnswer({ answer: { choice: 'url', url: value }, label: value.replace(/^https?:\/\//, '') })}
      />
      <div className="grid grid-cols-2 gap-2">
        <AnswerTile
          label="ما عندي موقع"
          compact
          disabled={busy}
          onClick={() => onAnswer({ answer: { choice: 'none' }, label: 'ما عندي موقع' })}
        />
        <AnswerTile
          label="بكتبه بعدين"
          compact
          disabled={busy}
          onClick={() => onAnswer({ answer: { choice: 'later' }, label: 'بكتبه بعدين' })}
        />
      </div>
    </div>
  );
}

const TONE: Record<SetupAccount['statusTone'], string> = {
  active: 'bg-success',
  attention: 'bg-danger',
  stopped: 'bg-muted-foreground',
};

export function AccountDock({
  accounts,
  busy,
  onChoose,
}: {
  accounts: SetupAccount[];
  busy: boolean;
  onChoose: (account: SetupAccount) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const needle = foldArabicSearch(toAsciiDigits(query.trim()));
    if (!needle) return accounts;
    const digits = needle.replace(/\D/g, '');
    return accounts.filter(
      (account) => foldArabicSearch(account.name).includes(needle) || (digits.length > 0 && account.customerId.includes(digits))
    );
  }, [accounts, query]);
  return (
    <div className="space-y-2">
      {accounts.length > 6 && (
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="دوّر باسم الحساب أو رقمه"
          aria-label="دوّر في الحسابات"
          className={inputClass}
        />
      )}
      {visible.map((account) => (
        <button
          key={account.customerId}
          type="button"
          disabled={busy}
          onClick={() => onChoose(account)}
          className="group flex min-h-[64px] w-full items-center gap-3 rounded-[16px] border border-border bg-card px-4 py-3 text-start transition-colors hover:bg-muted active:bg-foreground active:text-background disabled:opacity-50"
        >
          <span className={cn('h-2.5 w-2.5 flex-shrink-0 rounded-full', TONE[account.statusTone])} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15.5px] font-semibold">{account.name}</span>
            <span className="block text-[12.5px] text-muted-foreground group-active:text-background/80">
              {account.statusLabel}
              {account.spend30 !== null && (
                <>
                  ، صرف 30 يوم{' '}
                  <span className="numeric font-semibold">{formatCurrency(account.spend30, account.currency)}</span>
                </>
              )}
            </span>
          </span>
          <span className="numeric flex-shrink-0 text-[11.5px] text-muted-foreground group-active:text-background/70" dir="ltr">
            {account.customerId.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3')}
          </span>
        </button>
      ))}
      {visible.length === 0 && <p className="py-3 text-center text-[13px] text-muted-foreground">ما لقيت حساب بهالاسم.</p>}
    </div>
  );
}
