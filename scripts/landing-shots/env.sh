# Source this: env for building and serving the app against the fake backend.
# Fake Supabase + demo account «متجر عطور (حساب تجريبي)» for the landing screenshots. Synthetic data only.
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331
export NEXT_PUBLIC_SUPABASE_ANON_KEY=anon
export SUPABASE_SERVICE_ROLE_KEY=service
export CHAT_FIRST_ENTRY=true
export JARVIS_BRAIN_ENABLED=true
export ADAPTIVE_ONBOARDING=true
export VOICE_ASSISTANT_ENABLED=true
export VOICE_PROVIDER=mock
export VOICE_TICKET_SECRET=local-test-secret-0123456789abcdefghijklmnop
export NEXT_PUBLIC_APP_URL=http://localhost:3100
export NEXT_TELEMETRY_DISABLED=1
