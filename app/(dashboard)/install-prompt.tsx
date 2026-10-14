'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Ellipsis, Share, SquarePlus, X } from 'lucide-react';
import { LogoMark } from '@/lib/ui/logo';
import { cn } from '@/lib/utils';
import {
  INSTALL_STORAGE_KEY,
  isChromiumFamily,
  isIosThirdPartyBrowser,
  parseInstallMemory,
  resolveInstallMode,
  shouldOfferInstall,
  type InstallMemory,
  type InstallMode,
} from '@/lib/pwa/install';

/** The event Chrome and Edge raise when a site can be installed. Not in lib.dom. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    /** Set by the early script in app/layout.tsx, which can run before this component hydrates. */
    __modaafaInstallEvent?: BeforeInstallPromptEvent;
  }
}

/** Let the page settle before asking for anything. */
const REVEAL_DELAY_MS = 6000;
/** If a modal (the first-run tour) is open, look again later, a few times, then give up for this visit. */
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 6;

function isStandalone(): boolean {
  try {
    const nav = navigator as Navigator & { standalone?: boolean };
    if (nav.standalone === true) return true;
    return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay'].some(
      (mode) => window.matchMedia(`(display-mode: ${mode})`).matches
    );
  } catch {
    return false;
  }
}

/**
 * True while something modal is actually on screen (the first-run tour, the
 * audit overlay). A closed drawer is also marked aria-modal but is hidden, so
 * the check goes by what is visible, not by the markup alone.
 */
function isModalOpen(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).some((el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth;
  });
}

function readMemory(): InstallMemory {
  try {
    return parseInstallMemory(localStorage.getItem(INSTALL_STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeMemory(patch: InstallMemory) {
  try {
    localStorage.setItem(INSTALL_STORAGE_KEY, JSON.stringify({ ...readMemory(), ...patch }));
  } catch {
    // Private window or blocked storage: the banner may come back next visit.
  }
}

/**
 * Offers to install the platform as an app, once, a few seconds after the
 * customer lands inside it.
 *
 * Chrome and Edge: one tap opens the browser's own install dialog.
 * Safari on iPhone, iPad and Mac: no such event exists, so the card shows the
 * steps instead. Anywhere else (Firefox, in-app browsers, an app that is
 * already installed) it renders nothing. "Not now" is remembered for a month.
 */
export function InstallPrompt() {
  const promptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [mode, setMode] = useState<InstallMode>('none');
  const [visible, setVisible] = useState(false);
  const [steps, setSteps] = useState(false);
  const [thirdPartyIos, setThirdPartyIos] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent;
    const touchPoints = navigator.maxTouchPoints ?? 0;
    const initial = resolveInstallMode({ userAgent: ua, maxTouchPoints: touchPoints, standalone: isStandalone(), hasPromptEvent: false });
    // A Chromium browser reports 'none' until its event arrives; it is still a candidate.
    const chromiumCandidate = initial === 'none' && isChromiumFamily(ua);
    const candidate: InstallMode = chromiumCandidate ? 'native' : initial;

    if (!shouldOfferInstall(candidate, readMemory(), Date.now())) return;

    setThirdPartyIos(isIosThirdPartyBrowser(ua));

    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    let revealed = false;
    let cancelled = false;

    const tryReveal = () => {
      if (cancelled || revealed) return;
      if (isModalOpen()) {
        // Busy with something else. Look again a few times, then leave it for the next visit.
        if (retries < MAX_RETRIES) {
          retries += 1;
          revealTimer = setTimeout(tryReveal, RETRY_DELAY_MS);
        }
        return;
      }
      revealed = true;
      setVisible(true);
    };
    const scheduleReveal = () => {
      if (revealed || revealTimer !== undefined) return;
      revealTimer = setTimeout(tryReveal, REVEAL_DELAY_MS);
    };

    if (candidate === 'ios' || candidate === 'mac-safari') {
      setMode(candidate);
      scheduleReveal();
      return () => {
        cancelled = true;
        if (revealTimer) clearTimeout(revealTimer);
      };
    }

    if (candidate !== 'native') return;

    const adopt = (event: BeforeInstallPromptEvent) => {
      promptRef.current = event;
      setMode('native');
      scheduleReveal();
    };
    const onPrompt = (event: Event) => {
      event.preventDefault();
      adopt(event as BeforeInstallPromptEvent);
    };
    const onReady = () => {
      if (window.__modaafaInstallEvent) adopt(window.__modaafaInstallEvent);
    };
    const onInstalled = () => {
      writeMemory({ installed: true });
      promptRef.current = null;
      setVisible(false);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('modaafa:install-ready', onReady);
    window.addEventListener('appinstalled', onInstalled);
    onReady();

    // Chrome raises the event only for a site with a service worker that has a
    // fetch handler. See public/sw.js; it caches nothing.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }

    return () => {
      cancelled = true;
      if (revealTimer) clearTimeout(revealTimer);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('modaafa:install-ready', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    writeMemory({ dismissedAt: Date.now() });
    setVisible(false);
  }, []);

  const confirmDone = useCallback(() => {
    writeMemory({ installed: true });
    setVisible(false);
  }, []);

  const installNow = useCallback(async () => {
    const event = promptRef.current;
    if (!event) return;
    try {
      await event.prompt();
      const choice = await event.userChoice;
      writeMemory(choice.outcome === 'accepted' ? { installed: true } : { dismissedAt: Date.now() });
    } catch {
      // The browser refused to show its dialog; leave the banner for another try.
      return;
    }
    // An event can be prompted once. A fresh one arrives later if the browser allows.
    promptRef.current = null;
    window.__modaafaInstallEvent = undefined;
    setVisible(false);
  }, []);

  if (!visible || mode === 'none' || mode === 'installed') return null;

  const copy = COPY[mode];

  // z-[35]: above the pages' sticky headers (z-30) so its buttons can be
  // tapped, below the mobile tab bar and drawer (z-40, z-50) and the tour (z-100).
  return (
    <aside
      aria-label="اقتراح تثبيت مُضاعِف كتطبيق"
      className={cn(
        'fixed inset-x-3 top-[4.25rem] z-[35] border border-border-strong bg-card text-foreground motion-safe:animate-fade-in',
        // bottom-32 keeps it above the chat composer (about 100px from the bottom edge,
        // across laptop widths), whose send button sits at the same corner.
        'lg:inset-x-auto lg:bottom-32 lg:end-6 lg:top-auto lg:w-[384px]'
      )}
    >
      <div className="flex items-start gap-3 px-4 pb-3 pt-4">
        <LogoMark size={40} alt="" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-bold leading-6">{copy.title}</p>
          <p className="mt-1 text-balance text-[13px] leading-6 text-muted-foreground">{steps ? copy.stepsIntro : copy.body}</p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label="إغلاق"
          className="-me-1.5 -mt-1.5 flex h-10 w-10 flex-shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {steps && (
        <ol className="space-y-2.5 border-t border-border px-4 py-3.5 text-[13.5px] leading-6">
          {mode === 'ios' ? (
            <>
              <li className="flex gap-2.5">
                <Share className="mt-1 h-4 w-4 flex-shrink-0" aria-hidden />
                {thirdPartyIos ? (
                  <span>اضغط زر المشاركة في شريط العنوان.</span>
                ) : (
                  <span>
                    اضغط زر المشاركة أسفل الشاشة. ما لقيته؟ اضغط{' '}
                    <Ellipsis className="inline h-4 w-4 align-text-bottom" aria-label="النقاط الثلاث" /> أول، وبعدها
                    المشاركة.
                  </span>
                )}
              </li>
              <li className="flex gap-2.5">
                <SquarePlus className="mt-1 h-4 w-4 flex-shrink-0" aria-hidden />
                <span>
                  اختر «إضافة إلى الشاشة الرئيسية»، أو{' '}
                  <bdi dir="ltr" className="whitespace-nowrap font-medium">
                    Add to Home Screen
                  </bdi>{' '}
                  لو جوالك بالإنجليزي. القائمة طويلة، مرّر لتحت لين تطلع.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Check className="mt-1 h-4 w-4 flex-shrink-0" aria-hidden />
                <span>اضغط «إضافة» وتلقى مُضاعِف بين تطبيقاتك.</span>
              </li>
            </>
          ) : (
            <>
              <li className="flex gap-2.5">
                <SquarePlus className="mt-1 h-4 w-4 flex-shrink-0" aria-hidden />
                <span>
                  من قائمة «ملف» في أعلى الشاشة اختر «إضافة إلى Dock»، أو اضغط زر المشاركة{' '}
                  <Share className="inline h-4 w-4 align-text-bottom" aria-label="المشاركة" /> في أدوات سفاري
                  واختره من هناك. لو نظامك بالإنجليزي فهو{' '}
                  <bdi dir="ltr" className="whitespace-nowrap font-medium">
                    Add to Dock
                  </bdi>
                  .
                </span>
              </li>
              <li className="flex gap-2.5">
                <Check className="mt-1 h-4 w-4 flex-shrink-0" aria-hidden />
                <span>اضغط «إضافة». يفتح بعدها من Dock أو من بحث سبوتلايت.</span>
              </li>
            </>
          )}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {mode === 'native' && (
          <button
            type="button"
            onClick={installNow}
            className="flex min-h-11 items-center justify-center bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            ثبّته
          </button>
        )}
        {mode !== 'native' && !steps && (
          <button
            type="button"
            onClick={() => setSteps(true)}
            className="flex min-h-11 items-center justify-center bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            وريني كيف
          </button>
        )}
        {mode !== 'native' && steps && (
          <button
            type="button"
            onClick={confirmDone}
            className="flex min-h-11 items-center justify-center bg-primary px-5 text-[14px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            تم التثبيت
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          className="flex min-h-11 items-center justify-center px-3 text-[13.5px] text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
        >
          مو الحين
        </button>
      </div>
    </aside>
  );
}

const COPY: Record<'native' | 'ios' | 'mac-safari', { title: string; body: string; stepsIntro: string }> = {
  native: {
    title: 'ثبّت مُضاعِف كتطبيق على جهازك',
    body: 'يفتح بأيقونته في نافذة لحاله، بدون شريط المتصفح وبدون ما تدوّر على الرابط كل مرة. وتشيله وقت ما تبي.',
    stepsIntro: '',
  },
  ios: {
    title: 'حطّ مُضاعِف على شاشتك الرئيسية',
    body: 'يطلع بأيقونته بين تطبيقاتك ويفتح بملء الشاشة. آبل ما تخلي المواقع تثبّت نفسها، فالتثبيت يدوي وخطواته قصيرة.',
    stepsIntro: 'من نفس الصفحة اللي أنت فيها:',
  },
  'mac-safari': {
    title: 'ضيف مُضاعِف إلى Dock',
    body: 'يفتح بأيقونته في نافذة لحاله مثل أي برنامج. سفاري ما يثبّت المواقع تلقائياً، فتسويها من القائمة.',
    stepsIntro: 'من سفاري وأنت في هذي الصفحة:',
  },
};
