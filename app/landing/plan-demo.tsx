'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

type DemoState = 'pending' | 'approved' | 'dismissed';

/**
 * The hero's one interactive moment: a single decision from a daily plan that
 * the visitor can approve or dismiss, so the core promise (nothing changes
 * until you approve, and approvals can be undone for 30 days) is felt, not
 * read. Figures are illustrative and the card says so.
 */
export function PlanDemo({ className }: { className?: string }) {
  const [state, setState] = useState<DemoState>('pending');

  return (
    <section
      aria-label="مثال على قرار من خطة اليوم"
      className={cn('w-full max-w-[25rem] border border-brand-navy bg-white text-brand-navy', className)}
    >
      <header className="flex items-center justify-between gap-3 border-b border-brand-navy/15 px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn(
              'h-2.5 w-2.5 transition-colors duration-300',
              state === 'pending' ? 'bg-brand-signal' : 'bg-brand-navy'
            )}
          />
          <span className="text-[14px] font-bold">خطة اليوم</span>
          <span className="text-[12px] text-brand-slate">قرار 1 من 3</span>
        </div>
        <span className="text-[12px] text-brand-slate">
          الأحد{' '}
          <span dir="ltr" className="font-numeric">
            8:02
          </span>{' '}
          ص
        </span>
      </header>

      <div className="px-4 pb-4 pt-3.5">
        <p className="text-[11.5px] text-brand-slate">مثال توضيحي من حساب متجر عطور</p>
        <h3 className="mt-1.5 text-[17px] font-bold leading-7">أضف «دهن عود كمبودي» ككلمة بحث مطابقة</h3>

        <dl className="mt-3 grid grid-cols-3 border-y border-brand-navy/15 text-center">
          {[
            ['ضغطات', '31'],
            ['طلبات', '4'],
            ['الصرف بالريال', '87'],
          ].map(([label, value]) => (
            <div key={label} className="border-brand-navy/15 py-2 [&:not(:first-child)]:border-s">
              <dt className="text-[11px] text-brand-slate">{label}</dt>
              <dd className="font-numeric text-[15px] font-semibold">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-3 text-[13px] leading-6 text-brand-slate">
          <span className="font-semibold text-brand-navy">السبب: </span>
          هالعبارة جابت طلبات خلال آخر 30 يوم، وهي مو كلمة في حسابك، يعني تظهر لها بالصدفة. إضافتها تخليك تتحكم في سعرها.
        </p>

        <div aria-live="polite" className="mt-4">
          {state === 'pending' && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setState('approved')}
                className="h-11 flex-1 bg-brand-navy text-[14px] font-bold text-brand-paper transition-colors hover:bg-[#1c2540] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-navy"
              >
                اعتمد
              </button>
              <button
                type="button"
                onClick={() => setState('dismissed')}
                className="h-11 border border-brand-navy/30 px-5 text-[14px] font-semibold transition-colors hover:border-brand-navy"
              >
                تجاهل
              </button>
            </div>
          )}

          {state === 'approved' && (
            <div className="animate-fade-in border-s-2 border-brand-navy bg-brand-paper px-3 py-2.5">
              <p className="text-[13.5px] font-bold">اعتمدت. التعديل راح لحسابك في قوقل.</p>
              <p className="mt-0.5 text-[12.5px] text-brand-slate">
                وإذا غيرت رأيك تتراجع عنه بضغطة خلال 30 يوم.{' '}
                <button
                  type="button"
                  onClick={() => setState('pending')}
                  className="font-semibold text-brand-navy underline underline-offset-4"
                >
                  تراجع
                </button>
              </p>
            </div>
          )}

          {state === 'dismissed' && (
            <div className="animate-fade-in border-s-2 border-brand-slate bg-brand-paper px-3 py-2.5">
              <p className="text-[13.5px] font-bold">تجاهلته. ما تغيّر شي في حسابك.</p>
              <p className="mt-0.5 text-[12.5px] text-brand-slate">
                القرار يبقى عندك.{' '}
                <button
                  type="button"
                  onClick={() => setState('pending')}
                  className="font-semibold text-brand-navy underline underline-offset-4"
                >
                  رجّعه
                </button>
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
