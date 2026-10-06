import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { Alert } from '@/lib/ui/alert';
import { ConfirmForm } from './confirm-form';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'أكمل دخولك | مُضاعِف',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Landing page for the sign-in link in the email.
 *
 * It deliberately does NOT verify the token. Opening this page (a mail
 * scanner's prefetch, a link preview, a second tab) changes nothing; the
 * token is spent only when the person presses the button, which POSTs to
 * /auth/verify.
 */
export default async function AuthConfirmPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const tokenHash = first(params.token_hash);
  const type = first(params.type);
  const hasToken = Boolean(tokenHash && type);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md surface-card p-6 sm:p-8">
        <Link href="/" className="mb-7 flex items-center gap-3">
          <Image src="/logo-mark.svg" alt="مُضاعِف" width={40} height={40} className="h-10 w-10 rounded-xl" />
          <span className="text-[15px] font-semibold">مُضاعِف</span>
        </Link>

        {hasToken ? (
          <>
            <h1 className="text-2xl font-bold">أكمل دخولك إلى مُضاعِف</h1>
            <p className="mt-2 mb-6 text-sm leading-7 text-muted-foreground">
              اضغط الزر ونفتح لك حسابك على طول، بدون كلمة مرور.
            </p>
            <ConfirmForm
              tokenHash={tokenHash as string}
              type={type as string}
              next={first(params.next) ?? ''}
              redirectTo={first(params.redirect_to) ?? ''}
            />
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold">الرابط غير مكتمل</h1>
            <div className="mt-4 mb-6">
              <Alert tone="danger">
                الرابط اللي فتحته ناقص أو انقطع جزء منه. اطلب رابطاً جديداً من صفحة الدخول.
              </Alert>
            </div>
            <Link
              href="/login"
              className="flex h-12 w-full items-center justify-center rounded-lg bg-primary text-[0.9375rem] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              ارجع إلى صفحة الدخول
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
