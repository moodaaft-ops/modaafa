import type { Metadata } from 'next';
import { RegisterForm } from './register-form';
import { REGISTRATION_CONSENT_TEXT } from '@/lib/registration/consent';

export const metadata: Metadata = {
  title: 'إنشاء حساب',
};

export default function RegisterPage() {
  return <RegisterForm consentText={REGISTRATION_CONSENT_TEXT} />;
}
