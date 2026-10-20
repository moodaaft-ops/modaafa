/** Client-safe constants for autonomy levels (no server imports). Re-exported from ./autonomy. */

export const AUTONOMY_LEVELS = ['ask_all', 'small_and_notify'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'ask_all';

export const AUTONOMY_LEVEL_LABELS_AR: Record<AutonomyLevel, { title: string; body: string }> = {
  ask_all: {
    title: 'يستأذن في كل شي',
    body: 'ما يتغير شي في حسابك إلا بعد ما توافق أنت.',
  },
  small_and_notify: {
    title: 'ينفذ الصغير ويبلّغ',
    body: 'يمنع الكلمات اللي صرفت وما جابت شي، ويوقف الكلمة اللي تصرف بلا نتيجة، ويبلغك بكل تعديل مع زر تراجع. أي شي ثاني يستأذنك فيه.',
  },
};
