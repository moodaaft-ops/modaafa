import { detectInAppBrowser } from '../registration/in-app-browser';

/**
 * Suggesting the install of the platform as an app.
 *
 * No browser installs a site silently. Chrome and Edge hand the page an event
 * that opens their own install dialog when the page asks for it from a tap.
 * Safari on iPhone, iPad and Mac has no such event at all: the visitor has to
 * do it through the share menu, so the best a page can do there is show the
 * route. Firefox on desktop cannot install sites. In-app browsers (TikTok,
 * Instagram, Facebook, Snapchat) cannot either, and their visitors are one
 * "open in browser" tap away from a place where they could.
 *
 * Everything in this file is pure so it can be tested without a browser.
 */
export type InstallMode =
  /** Already running as an installed app. */
  | 'installed'
  /** Chrome, Edge, Samsung Internet: the one-tap prompt is available. */
  | 'native'
  /** iPhone or iPad in a browser that has a share sheet. */
  | 'ios'
  /** Safari 17 or later on a Mac: Add to Dock. */
  | 'mac-safari'
  /** Nothing to offer here. */
  | 'none';

export type InstallEnv = {
  userAgent: string;
  maxTouchPoints: number;
  /** display-mode: standalone (or similar) or navigator.standalone. */
  standalone: boolean;
  /** The browser's beforeinstallprompt event has been captured. */
  hasPromptEvent: boolean;
};

const IOS_DEVICE = /iPhone|iPad|iPod/;
// iPadOS 13 and later announces itself as a Mac; only touch gives it away.
const IPADOS_AS_MAC = /Macintosh/;
const IOS_OTHER_BROWSER = /CriOS|EdgiOS|FxiOS|OPiOS/;
const NOT_SAFARI_ON_MAC = /Chrome|Chromium|CriOS|Edg\/|EdgA|OPR\/|Firefox|FxiOS|SamsungBrowser/;

export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (IOS_DEVICE.test(userAgent)) return true;
  return IPADOS_AS_MAC.test(userAgent) && maxTouchPoints > 1;
}

/** Chrome, Edge or Firefox on iOS: they have their own share button in the address bar. */
export function isIosThirdPartyBrowser(userAgent: string): boolean {
  return IOS_OTHER_BROWSER.test(userAgent);
}

function safariMajorVersion(userAgent: string): number | null {
  const match = userAgent.match(/Version\/(\d+)/);
  return match ? Number(match[1]) : null;
}

export function resolveInstallMode(env: InstallEnv): InstallMode {
  if (env.standalone) return 'installed';

  const ua = env.userAgent.slice(0, 1000);
  if (detectInAppBrowser(ua)) return 'none';

  if (isIosDevice(ua, env.maxTouchPoints)) {
    // A web view inside some other app (a mail client, a notes app) has no
    // "Safari/" token and no share sheet that can add to the Home Screen.
    const isRealBrowser = /Safari\//.test(ua) || isIosThirdPartyBrowser(ua);
    return isRealBrowser ? 'ios' : 'none';
  }

  // Safari on a Mac from Sonoma (Safari 17) on. Chrome on a Mac also carries
  // the "Safari/" token, hence the exclusion list.
  if (/Macintosh/.test(ua) && /Safari\//.test(ua) && !NOT_SAFARI_ON_MAC.test(ua)) {
    const version = safariMajorVersion(ua);
    return version !== null && version >= 17 ? 'mac-safari' : 'none';
  }

  return env.hasPromptEvent ? 'native' : 'none';
}

/** What the visitor chose last time, kept in the browser. */
export type InstallMemory = {
  /** Epoch ms of the last "not now". */
  dismissedAt?: number;
  /** The visitor installed (or the browser said so). Never ask again. */
  installed?: boolean;
};

export const INSTALL_STORAGE_KEY = 'modaafa-install';

/**
 * After "not now" the offer stays away for a month. A person who said no
 * yesterday has not changed their mind today, and the browser's own install
 * entry (address bar icon, share menu) is still there if they do.
 */
export const DISMISS_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export function parseInstallMemory(raw: string | null): InstallMemory {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const { dismissedAt, installed } = value as Record<string, unknown>;
    const memory: InstallMemory = {};
    if (typeof dismissedAt === 'number' && Number.isFinite(dismissedAt)) memory.dismissedAt = dismissedAt;
    if (installed === true) memory.installed = true;
    return memory;
  } catch {
    return {};
  }
}

export function shouldOfferInstall(mode: InstallMode, memory: InstallMemory, now: number): boolean {
  if (mode === 'none' || mode === 'installed') return false;
  if (memory.installed) return false;
  if (memory.dismissedAt !== undefined) {
    // A clock set backwards gives a negative age; treat that as "still cooling down".
    const age = now - memory.dismissedAt;
    if (age < DISMISS_COOLDOWN_MS) return false;
  }
  return true;
}

/**
 * Browsers built on Chromium: the family that raises beforeinstallprompt.
 * Chrome on iOS is not in it (its token is "CriOS", and it is WebKit
 * underneath), and neither are Android web views, marked by "; wv)".
 */
export function isChromiumFamily(userAgent: string): boolean {
  const ua = userAgent.slice(0, 1000);
  if (/; wv\)/.test(ua)) return false;
  return /Chrome\/|Chromium\/|Edg\/|EdgA\/|SamsungBrowser\/|OPR\//.test(ua);
}
