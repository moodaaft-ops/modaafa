/**
 * Every word of the exit popup and its phone bar. Kept in one file so the
 * copy can be read and approved without opening the component, and so a test
 * can check it against the writing rules.
 */
export const EXIT_COPY = {
  title: 'شوف شكل التقرير قبل ما تربط حسابك',
  body: 'نرسل لك نموذج تقرير فحص من مُضاعِف، تشوف فيه كيف نرتب الصرف الضايع بالريال.',
  barTitle: 'تبي تشوف شكل التقرير قبل الربط؟',
  barOpen: 'أبي النموذج',

  channelEmail: 'على الإيميل',
  channelWhatsapp: 'على الواتساب',
  emailLabel: 'إيميلك',
  whatsappLabel: 'رقم الواتساب',
  emailPlaceholder: 'name@example.com',
  whatsappPlaceholder: '05xxxxxxxx',
  submit: 'ابعث لي النموذج',
  sending: 'جاري الإرسال...',
  consent: 'نستخدم بياناتك لإرسال النموذج والمتابعة معك عليه، وتوقف الرسائل متى ما بغيت.',
  dismiss: 'لا، شكراً',
  close: 'إغلاق',

  doneEmail: 'وصلنا طلبك، والنموذج يجيك على إيميلك. لو تأخر شوف الرسائل غير المهمة.',
  doneWhatsapp: 'وصلنا رقمك. يرسل لك النموذج أيمن أو أحد من الفريق بنفسه، فقد يتأخر شوي.',

  errors: {
    invalid_email: 'الإيميل مو مكتوب صح.',
    invalid_whatsapp: 'الرقم مو صحيح، اكتبه مثل 05xxxxxxxx.',
    too_many_requests: 'جرّبت أكثر من مرة. جرّب بعد ساعة.',
    unavailable: 'صار خلل عندنا. جرّب بعد شوي.',
  },
} as const;
