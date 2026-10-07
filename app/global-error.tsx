'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        {/* This route renders outside the app shell, so the theme tokens and
            the no-FOUC script are unavailable. Without this a dark-mode user
            gets a full-white flash at the worst possible moment. */}
        <style>{`
          :root { color-scheme: light dark; }
          @media (prefers-color-scheme: dark) {
            body { background: #0E1426 !important; color: #F4F2EC !important; }
            .modaafa-error-body { color: #9AA0AE !important; }
            .modaafa-error-digest { color: #7A8294 !important; }
          }
        `}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#F4F2EC',
          color: '#0E1426',
          fontFamily:
            "'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif",
          textAlign: 'center',
          padding: '24px',
        }}
      >
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '12px' }}>
            حدث خطأ غير متوقع في المنصة
          </h1>
          <p
            className="modaafa-error-body"
            style={{ fontSize: '14px', color: '#586174', maxWidth: '420px', lineHeight: 1.8 }}
          >
            تعذر تحميل مُضاعِف الآن. جرّب إعادة المحاولة، وإذا استمرت المشكلة فأعد فتح الصفحة بعد قليل.
          </p>
          {error?.digest && (
            <p
              className="modaafa-error-digest"
              style={{ fontSize: '12px', color: '#9AA0AE', marginTop: '8px' }}
              dir="ltr"
            >
              {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '20px',
              background: '#0E1426',
              color: '#F4F2EC',
              border: 'none',
              borderRadius: '0',
              padding: '10px 20px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            إعادة المحاولة
          </button>
        </div>
      </body>
    </html>
  );
}
