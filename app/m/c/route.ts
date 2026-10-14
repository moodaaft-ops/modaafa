import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { verifyTrackedLink } from '@/lib/messaging/links';
import { recordClick } from '@/lib/messaging/click';

/**
 * Click tracking for the buttons in our emails.
 *
 *   /m/c?u=<user>&k=<template key>&p=<internal path>&s=<signature>
 *
 * The signature covers all three values, so the only paths this can send
 * anyone to are ones one of our own emails carried, and always on our own
 * origin (the Location header is a relative path, never a host). Anything that
 * does not verify goes to the home page.
 *
 * The first click stamps message_log.clicked_at and every click bumps
 * click_count. Recording is best effort: the redirect never waits on it
 * failing. HEAD is answered without counting, because mail scanners and link
 * previewers probe with HEAD.
 */
export const dynamic = 'force-dynamic';

const HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

function redirectTo(location: string) {
  return new Response(null, { status: 302, headers: { ...HEADERS, location } });
}

function resolve(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  return verifyTrackedLink({ u: q.get('u'), k: q.get('k'), p: q.get('p'), s: q.get('s') });
}

export async function GET(req: NextRequest) {
  const click = resolve(req);
  if (!click) return redirectTo('/');

  try {
    await recordClick(createAdminClient(), click.userId, click.templateKey);
  } catch (error) {
    console.error('email click not recorded', { template: click.templateKey, error });
  }
  return redirectTo(click.target);
}

export function HEAD(req: NextRequest) {
  const click = resolve(req);
  return redirectTo(click ? click.target : '/');
}
