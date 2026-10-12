import type { Metadata } from 'next';
import Link from 'next/link';
import { after } from 'next/server';
import { redirect } from 'next/navigation';
import { ChevronDown, MessageCircle } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { trackUserEvent } from '@/lib/events/user-events';
import { NO_ACCOUNT_PATH } from '@/lib/onboarding/ads-guide';
import { whatsappHelpUrl } from '@/lib/support/contact';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { buttonClasses } from '@/lib/ui/button';
import { LogoMark } from '@/lib/ui/logo';
import { getWelcomeVideo, isGoogleAppVerified } from '@/lib/welcome/config';
import { WELCOME_COPY as copy } from '@/lib/welcome/copy';
import { WelcomeConnectButton } from './welcome-connect-button';
import { WelcomeVideoFrame } from './welcome-video';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: copy.pageTitle,
  robots: { index: false, follow: false },
};

/**
 * First screen after sign-up, and the screen every not-yet-connected user sees
 * on each sign-in. Once any Google Ads account is linked (active, expired or
 * paused) it stops appearing and sends the person to the dashboard.
 *
 * `onboarding_viewed` is written after the response is sent and only the first
 * time (a unique index in user_events enforces "first time"), so a slow or
 * missing table can never delay or break this page.
 */
export default async function WelcomePage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/welcome');

  const { accounts, revokedAccounts, pausedAccounts } = await getAccountWorkspace(user.id);
  if (accounts.length + revokedAccounts.length + pausedAccounts.length > 0) redirect('/dashboard');

  const userId = user.id;
  after(() => trackUserEvent({ userId, event: 'onboarding_viewed', properties: { surface: 'welcome' } }));

  const video = getWelcomeVideo();
  const verified = isGoogleAppVerified();
  const teamHref = whatsappHelpUrl('talk_to_team', user.email);
  const noAccountHref = whatsappHelpUrl('no_ads_account', user.email);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-xl px-4 pb-14 pt-5 sm:px-6 sm:pt-8">
        <header className="flex items-center gap-2.5">
          <LogoMark size={30} alt="" />
          <span className="text-[15px] font-bold">مُضاعِف</span>
        </header>

        <section className="mt-9 sm:mt-12">
          <p className="flex items-center gap-2 text-[12.5px] font-semibold text-muted-foreground">
            <span className="status-square bg-signal" aria-hidden />
            {copy.eyebrow}
          </p>
          <h1 className="mt-3 text-[30px] font-bold leading-[1.35] sm:text-[40px] sm:leading-[1.3]">
            {copy.headline}
          </h1>
          <p className="mt-4 text-[15px] leading-8 text-muted-foreground sm:text-base">{copy.intro}</p>

          <div className="mt-7">
            <WelcomeConnectButton label={copy.connectLabel} loadingLabel={copy.connectLoading} />
            <p className="mt-3 text-[12.5px] leading-6 text-muted-foreground">{copy.connectNote}</p>
            <a
              href={teamHref}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-foreground underline decoration-border-strong underline-offset-[6px] hover:decoration-foreground"
            >
              <MessageCircle className="h-4 w-4" aria-hidden />
              {copy.teamLinkLabel}
            </a>
          </div>
        </section>

        {video && (
          <section className="mt-10" aria-label={copy.videoHeading}>
            <h2 className="mb-3 text-[15px] font-bold">{copy.videoHeading}</h2>
            <WelcomeVideoFrame video={video} caption={copy.videoCaption} />
          </section>
        )}

        <section className="mt-12" aria-labelledby="welcome-steps">
          <h2 id="welcome-steps" className="text-xl font-bold">
            {copy.stepsHeading}
          </h2>
          <ol className="mt-5">
            {copy.steps.map((step, index) => {
              const last = index === copy.steps.length - 1;
              const note = 'unverifiedNote' in step && !verified ? step.unverifiedNote : null;
              return (
                <li key={step.title} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <span className="numeric flex h-8 w-8 flex-shrink-0 items-center justify-center bg-signal text-[14px] font-bold text-signal-foreground">
                      {index + 1}
                    </span>
                    {!last && <span className="my-1 w-px flex-1 bg-border" aria-hidden />}
                  </div>
                  <div className={last ? 'min-w-0 pb-0' : 'min-w-0 pb-6'}>
                    <h3 className="pt-1 text-[16px] font-bold leading-7">{step.title}</h3>
                    <p className="mt-1 text-[14px] leading-7 text-muted-foreground">{step.body}</p>
                    {note && (
                      <p className="mt-2 border-s-2 border-signal bg-background-elevated px-3 py-2 text-[13px] leading-7 text-foreground">
                        {note}
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-6 border-s-2 border-border-strong ps-3 text-[13px] leading-7 text-muted-foreground">
            {copy.limitNote}
          </p>
        </section>

        <section className="mt-12" aria-labelledby="welcome-trust">
          <h2 id="welcome-trust" className="text-xl font-bold">
            {copy.trustHeading}
          </h2>
          <div className="mt-4 divide-y divide-border border-y border-border">
            {copy.trust.map((item) => (
              <details key={item.id} className="group">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 py-3 text-[15px] font-semibold leading-7 [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">{item.question}</span>
                  <ChevronDown
                    className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-180"
                    aria-hidden
                  />
                </summary>
                <div className="space-y-2.5 pb-5">
                  {item.answer.map((line) => (
                    <p
                      key={line}
                      className={
                        line.startsWith('حد صريح')
                          ? 'border-s-2 border-signal ps-3 text-[13.5px] font-medium leading-7 text-foreground'
                          : 'text-[14px] leading-8 text-muted-foreground'
                      }
                    >
                      {line}
                    </p>
                  ))}
                  {'linkHref' in item && item.linkHref && (
                    <a
                      href={item.linkHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center text-[13px] font-semibold text-primary underline underline-offset-4"
                    >
                      {item.linkLabel}
                    </a>
                  )}
                  {item.id === 'no-account' && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <a
                        href={noAccountHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClasses({ variant: 'outline' })}
                      >
                        <MessageCircle className="h-4 w-4" aria-hidden />
                        {copy.noAccountWhatsApp}
                      </a>
                      <Link href={NO_ACCOUNT_PATH} className={buttonClasses({ variant: 'ghost' })}>
                        {copy.noAccountGuide}
                      </Link>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </section>

        <section className="mt-12 border-t border-border pt-8">
          <WelcomeConnectButton label={copy.connectLabel} loadingLabel={copy.connectLoading} />
          <a
            href={teamHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-foreground underline decoration-border-strong underline-offset-[6px] hover:decoration-foreground"
          >
            <MessageCircle className="h-4 w-4" aria-hidden />
            {copy.teamLinkLabel}
          </a>
        </section>
      </div>
    </main>
  );
}
