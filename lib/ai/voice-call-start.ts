/**
 * The awaited steps that open a call: session, microphone permission, audio
 * context. Each await can outlive the call: the person may end it, switch
 * account or close the panel while the session request or the browser's
 * permission prompt is still pending. Every step re-checks `isCurrent()` and
 * releases only what THIS attempt acquired, so a late result can never open
 * the microphone after the call is over, and a session that arrives late is
 * closed on the server.
 */
export type SessionOpened = { ok: true; token: string } | { ok: false; error?: unknown };

export type CallStartDeps<Ctx, Stream> = {
  /** False once the call was ended or the panel torn down since this attempt began. */
  isCurrent(): boolean;
  createContext(): Ctx;
  closeContext(ctx: Ctx): void;
  openSession(): Promise<SessionOpened>;
  /** Fire-and-forget close of a session token on the server. */
  endSessionOnServer(token: string): void;
  acquireMic(): Promise<Stream>;
  stopStream(stream: Stream): void;
  resumeContext(ctx: Ctx): Promise<void>;
  /** Wires the audio graph, the refs and the polling interval. Only ever called for a live attempt. */
  commit(parts: { ctx: Ctx; stream: Stream; token: string }): void;
};

export type CallStartResult =
  | { status: 'started' }
  | { status: 'cancelled' }
  | { status: 'session_failed'; error?: unknown }
  | { status: 'failed'; error: unknown };

export async function runCallStart<Ctx, Stream>(d: CallStartDeps<Ctx, Stream>): Promise<CallStartResult> {
  const ctx = d.createContext();
  let stream: Stream | null = null;
  let token: string | null = null;
  const abandon = (): CallStartResult => {
    // Only what this attempt created: the context, a mic it already got, a session that arrived late.
    if (stream !== null) d.stopStream(stream);
    d.closeContext(ctx);
    if (token) d.endSessionOnServer(token);
    return { status: 'cancelled' };
  };
  try {
    const session = await d.openSession();
    if (session.ok) token = session.token;
    if (!d.isCurrent()) return abandon();
    if (!session.ok) {
      d.closeContext(ctx);
      return { status: 'session_failed', error: session.error };
    }

    stream = await d.acquireMic();
    if (!d.isCurrent()) return abandon();

    await d.resumeContext(ctx);
    if (!d.isCurrent()) return abandon();

    d.commit({ ctx, stream, token: session.token });
    return { status: 'started' };
  } catch (error) {
    // A failure that lands after the call was over is not worth showing.
    if (!d.isCurrent()) return abandon();
    if (stream !== null) d.stopStream(stream);
    d.closeContext(ctx);
    // The session was opened for a call that never started (mic refused, resume failed):
    // close it, so a retry opens a fresh one instead of reusing a dead token.
    if (token) d.endSessionOnServer(token);
    return { status: 'failed', error };
  }
}
