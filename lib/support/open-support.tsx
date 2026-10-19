'use client';

import React, { type AnchorHTMLAttributes, type MouseEvent } from 'react';

/**
 * A WhatsApp link that hands the person to the support bot first.
 *
 * It is a normal link to WhatsApp. When the bot's window is on the page (the
 * widget marks <html data-support-bot="1"> once it mounts), a plain click opens
 * the window instead, optionally on one of the ready-made answers or with a
 * question already sent. With the flag off, before the page's script runs, or
 * when the person opens the link in a new tab, it is exactly the old button.
 * That is why the public pages can stay static and why switching the bot off
 * restores every button without touching them.
 */

export const OPEN_SUPPORT_EVENT = 'modaafa:open-support';

export type OpenSupportDetail = {
  /** Id of a ready-made FAQ answer to show (costs nothing). */
  faqId?: string;
  /** A question to send to the bot as if the person had typed it. */
  prompt?: string;
};

export function supportBotIsOnPage() {
  return typeof document !== 'undefined' && document.documentElement.dataset.supportBot === '1';
}

export function openSupport(detail: OpenSupportDetail = {}) {
  window.dispatchEvent(new CustomEvent<OpenSupportDetail>(OPEN_SUPPORT_EVENT, { detail }));
}

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  /** The direct WhatsApp link, used whenever the bot is not on the page. */
  href: string;
  support?: OpenSupportDetail;
};

export function SupportLink({ href, support, onClick, children, ...rest }: Props) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Let modified clicks (new tab, new window, download) keep their meaning.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!supportBotIsOnPage()) return;
    event.preventDefault();
    openSupport(support);
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
