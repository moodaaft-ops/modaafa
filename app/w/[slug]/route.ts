import type { NextRequest } from 'next/server';
import { createLeadRedirectHandler } from '@/lib/lead-loop/redirect-handler';

export const dynamic = 'force-dynamic';

const handle = createLeadRedirectHandler();

export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return handle(req, slug);
}

export async function HEAD(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return handle(req, slug);
}
