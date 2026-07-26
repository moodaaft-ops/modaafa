# Moodaaft Ads AI - UI/UX Handoff for Claude

This file is a complete UI/UX handoff for the Moodaaft Ads AI platform.
Use it as the main prompt and implementation brief. Do not ask the owner to
repeat context unless a production credential or external approval is truly
required.

## One-Sentence Product

Moodaaft Ads AI is an Arabic-first SaaS platform that lets a customer sign in
with Google, connect all Google Ads accounts they can access, select one active
ad account from a dashboard, chat with an AI media-buyer assistant, run account
audits, review recommendations, and approve changes before execution.

## Current Live Context

- Production app: https://ai.modaafa.com
- Repo path on this machine: `/Users/aimanamin/Documents/GitHub/modaafa`
- Primary user/business profile for browser testing: Chrome profile `مُضاعفة`
- Google account used for this project: `moodaaft@gmail.com`
- Product language: Arabic first. English can exist as a secondary UI mode.
- Important: do not expose, print, copy, or modify secrets unless the owner
  explicitly asks. Never include env values in notes or screenshots.

## Owner's Current Pain

The owner is unhappy with the UI/UX quality. The product works better now at the
backend/API level, but the interface still feels unfinished, confusing, and not
trustworthy enough for a SaaS customer. The main complaints:

- The design does not look premium or mature enough.
- First-time users do not know where to start.
- The dashboard feels cluttered and has weak visual hierarchy.
- Some actions take seconds, and the user gets no clear loading feedback.
- The sidebar/navigation behavior can feel inconsistent.
- The account switcher is central to the product and must be much better.
- The app became English in places; it should be Arabic-first or bilingual in a
  deliberate, polished way.
- Google Ads external OAuth screens can show Google warnings while app
  verification is pending; the product should explain this clearly inside the
  platform before redirecting.
- Some Google Ads accounts do not return names from Google API. The UI must
  explain this without making the platform look broken, and offer manual naming.
- The assistant UI should feel like a real AI media buyer, not a static FAQ box.

## What Is Already Working

Do not redesign as if this is just a static mockup. The product has real flows:

- Google login exists.
- Google Ads OAuth connect exists.
- The platform can auto-link accessible Google Ads accounts under the signed-in
  email, including manager/MCC children.
- The account switcher can switch between linked ad accounts.
- Some account names now resolve from Google Ads API.
- Accounts that Google does not name can be manually renamed from settings.
- Dashboard data and campaign tables render from cached Google Ads data.
- Manual sync works after OAuth env repair.
- Audit, assistant, optimizer, reports, billing, settings routes exist.
- Route loading/progress components exist and should be improved rather than
  deleted blindly.

## Non-Negotiable Product Logic

Do not break these:

- A user signs in with Google.
- A user connects Google Ads once.
- The app should discover/link all accessible non-manager customer accounts it
  can safely manage.
- The user chooses the active ad account inside the dashboard.
- All pages must reflect the currently selected ad account.
- Manager accounts must not be used for campaign metrics.
- Any destructive or material ad-account change must go through review/approval.
- The UI must communicate when an account is disabled, closed, suspended, or not
  returning a name from Google.
- Keep the backend Google Ads and OAuth logic intact unless you find a real bug.
- Do not print or commit secrets.

## Technical Stack

- Next.js 14 App Router
- React 18
- TypeScript
- Tailwind CSS
- Supabase SSR
- Google Ads REST wrapper
- Anthropic SDK for AI assistant behavior
- Stripe/Moyasar billing code exists
- Icons: `lucide-react`

Useful commands:

```bash
cd /Users/aimanamin/Documents/GitHub/modaafa
export PATH="/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/next build
./node_modules/.bin/next dev
```

If `node`, `npm`, or `pnpm` are missing from PATH, use the bundled Node path
above.

## Core Files to Inspect First

Start with these files before making design decisions:

- `app/page.tsx` - current landing page
- `app/(auth)/login/page.tsx` - login and first auth impression
- `app/onboarding/page.tsx` - onboarding entry
- `app/onboarding/business/page.tsx` - business setup step
- `app/onboarding/connect/page.tsx` - Google Ads connect step
- `app/onboarding/connect/connect-google-ads-button.tsx`
- `app/onboarding/select-account/page.tsx`
- `app/onboarding/onboarding-progress.tsx`
- `app/(dashboard)/layout.tsx` - main app shell/sidebar
- `app/(dashboard)/account-switcher.tsx` - critical account selection UX
- `app/(dashboard)/dashboard/page.tsx`
- `app/(dashboard)/assistant/page.tsx`
- `app/(dashboard)/assistant/assistant-client.tsx`
- `app/(dashboard)/audit/page.tsx`
- `app/(dashboard)/campaigns/page.tsx`
- `app/(dashboard)/optimizer/page.tsx`
- `app/(dashboard)/reports/page.tsx`
- `app/(dashboard)/billing/page.tsx`
- `app/(dashboard)/settings/page.tsx`
- `app/(dashboard)/loading.tsx`
- `app/(dashboard)/back-button.tsx`
- `lib/ui/route-progress.tsx`
- `lib/ui/pending-submit-button.tsx`
- `lib/accounts/display.ts`
- `tailwind.config.ts`
- `public/logo.svg`
- `public/logo-mark.svg`
- `app/icon.svg`
- `app/manifest.ts`

## UI/UX Direction

The platform should feel like a serious operational SaaS for media buyers and
business owners, not a landing-page toy. It should be clean, fast, Arabic-native,
and confidence-building.

Visual tone:

- Premium but practical.
- Arabic-first RTL done intentionally.
- Dense enough for campaign/account work, but not cramped.
- Calm neutral surfaces with meaningful green/amber/red status colors.
- Avoid overdecorated hero sections, one-note color palettes, giant cards, and
  marketing fluff inside the app.
- Use icons where they help: account switch, sync, audit, approval, campaigns,
  assistant, billing, settings.
- Buttons and controls must show loading/disabled states immediately.
- Cards should be at most 8px radius unless already established otherwise.
- Do not put cards inside cards unless it is truly a nested tool/modular control.

Suggested design language:

- Background: off-white/very light slate.
- Main content: crisp white panels, table surfaces, clear separators.
- Brand accent: existing emerald/green, but avoid everything being green.
- Use amber for caution, red for true errors, blue for informational notices.
- Keep Arabic typography readable, with strong hierarchy and no negative letter
  spacing.

## Required UI/UX Work

### 1. Landing Page

Create a real landing page for the SaaS, not just a basic intro.

Requirements:

- First viewport should clearly say what Moodaaft does.
- Show the product itself in the first viewport: dashboard/account/assistant
  preview, not abstract shapes.
- Explain the core flow: sign in -> connect Google Ads -> choose account -> AI
  audit/chat -> approve recommendations.
- Add sections for: features, safety/approval model, who it is for, onboarding
  flow, pricing teaser or CTA.
- CTA should route to login.
- Arabic first, optional English copy only if language toggle exists.
- Must look production-worthy.

### 2. Login Experience

Fix the returning-user feeling. If a user logs out and signs back in with the
same email, the UI should not feel like first-time registration.

UI expectations:

- Clear login page with brand, value, and "Continue with Google".
- If returning user has business/accounts, route copy should imply "back to
  dashboard", not "start from zero".
- Error states for Google login should be human-readable.
- If OAuth external screen shows warning because Google verification is pending,
  explain before redirecting from `/onboarding/connect`.

### 3. Onboarding

Make onboarding feel like one guided setup, not unrelated pages.

Current steps:

- Business profile
- Connect Google Ads
- Select account or auto-link accounts
- First audit/check

Needed:

- Persistent stepper/progress at top.
- When user submits business data, move to next step in the same flow feeling.
- Each step needs one clear primary action.
- Add helpful microcopy that explains why each permission is needed.
- Provide "Skip to dashboard" only where safe, not as a confusing escape hatch.
- Show what has been completed and what remains.

### 4. Dashboard Shell

The dashboard shell is the product. Improve it heavily.

Needed:

- Persistent sidebar on desktop.
- Strong mobile navigation solution.
- Account switcher visible and obvious.
- Selected account context must be clear on every page.
- Back button behavior should be consistent and not hide navigation.
- Loading states for route changes should be visible immediately.
- Header should show page title, account, last sync, and primary action where
  useful.
- Make empty states actionable and specific.

### 5. Account Switcher

This is a critical control. Redesign it as a polished account management control.

Requirements:

- Show selected account name and ID.
- Allow search by name or ID.
- Support many accounts.
- Show status tags if known: enabled, suspended, closed, unnamed, manager if ever
  shown.
- Explain unnamed accounts: "Google did not return a visible account name. You
  can rename it locally."
- Add direct action to rename unnamed account or link to settings.
- Sync button should show loading immediately.
- If sync succeeds, show a small success state with updated date.
- If sync fails because account is disabled/closed, show clear non-scary message.
- Avoid generic "failed, reconnect" unless token is actually invalid/revoked.

### 6. Assistant UX

Make the assistant feel useful and alive.

Needed:

- Chat area with clear account context.
- Suggested prompts based on current account data:
  - "وش أهم توصية أبدأ فيها؟"
  - "حلل الصرف آخر 7 أيام"
  - "ما الحملات اللي تحتاج إيقاف؟"
  - "اقترح كلمات سلبية"
- Responses should show evidence cards when possible:
  spend, conversions, campaigns, recommendation source.
- Empty state should explain what the assistant can do without sounding like a
  tutorial wall.
- Loading/typing state must appear instantly.
- If AI API fails, message should say the assistant had a temporary issue, not
  pretend with static content.

### 7. Audit / Optimizer / Approvals

These pages should feel like a decision workflow:

- Audit finds issues.
- Optimizer translates them into recommendations.
- User reviews/approves.
- System queues/applies safe actions.

Needed:

- Clear severity labels.
- Impact preview.
- "Why this matters" explanation.
- "Approve", "Dismiss", "Needs review" states.
- Guardrail copy: no change is applied without approval.

### 8. Campaigns and Reports

Improve scanability:

- Tables should have sticky-ish headers if long.
- Show campaign status clearly.
- Cost/conversion metrics should be formatted consistently.
- Empty state should say whether account has no data, sync is needed, or access
  is blocked.
- Provide filters/date range if lightweight.

### 9. Settings and Account Deletion

Settings must include:

- Business profile summary.
- Linked ad accounts with rename controls.
- Manual rename for unnamed Google Ads accounts.
- Sign out.
- Delete account permanently with clear confirmation copy.
- Explain what deletion removes.

### 10. Bilingual Support

Owner asked why the platform became English. Preferred solution:

- Arabic default.
- Add a lightweight language switch if feasible.
- If full i18n is too much for this pass, at least remove accidental English
  headings and make mixed labels intentional:
  - Arabic main text
  - English only for product/Google Ads terms when helpful.

## Microcopy Rules

Use clear Arabic. Avoid robotic text.

Good examples:

- "اختر الحساب الذي تريد العمل عليه الآن."
- "نقوم بتحديث البيانات من Google. قد يستغرق ذلك بضع ثوان."
- "Google لم ترجع اسماً ظاهراً لهذا الحساب. يمكنك تسميته داخل المنصة."
- "هذا الحساب متوقف في Google Ads، لذلك لا يمكن قراءة الأداء حالياً."
- "لن ننفذ أي تعديل قبل موافقتك."

Avoid:

- "حدث خطأ غير معروف"
- "تعذر تنفيذ العملية" without next step
- English headings mixed randomly with Arabic
- Big explanatory paragraphs inside compact controls

## Loading and Feedback Requirements

Every slow action needs immediate feedback:

- Login redirect
- Connect Google Ads
- Sync account
- Repair account names
- Select account
- Run audit
- Ask assistant
- Approve recommendation
- Billing checkout

Use:

- Button spinners
- Disabled state
- Optimistic "جاري..."
- Toast/inline success
- Clear error states
- Route progress bar

## Accessibility and Responsive Requirements

- RTL layout must remain correct at desktop and mobile.
- Text must not overflow cards/buttons.
- Buttons must be reachable and have clear labels.
- Color cannot be the only status signal.
- Inputs should have labels or accessible names.
- Tables need mobile fallbacks or horizontal scroll with clear affordance.
- Test at desktop and mobile widths.

## Suggested Implementation Approach

Do not rewrite the whole app in one chaotic pass. Work in layers:

1. Establish UI primitives and layout consistency:
   - page header
   - empty state
   - status badge
   - metric card
   - section panel
   - loading button/state

2. Redesign dashboard shell and account switcher.

3. Redesign onboarding flow.

4. Redesign landing/login.

5. Improve assistant/audit/campaigns/reports/settings pages.

6. Run TypeScript/build and visual pass.

## Files You May Add

Useful additions:

- `lib/ui/page-header.tsx`
- `lib/ui/empty-state.tsx`
- `lib/ui/status-badge.tsx`
- `lib/ui/metric-card.tsx`
- `lib/ui/skeleton.tsx`
- `lib/ui/toast-or-inline-feedback.tsx` if not already available
- `lib/i18n/*` only if implementing a real bilingual system

Use existing Tailwind and lucide-react before adding new UI libraries.

## Files To Avoid Touching Unless Necessary

Avoid backend changes unless a UI issue requires a tiny response-field addition:

- `lib/google-ads/client.ts`
- `lib/google-ads/oauth.ts`
- `app/api/auth/google-ads/*`
- `app/api/accounts/*`
- `lib/crypto.ts`
- `lib/supabase/server.ts`
- `db/schema.sql`
- `.env*`
- Vercel config/secrets

## Important Known Backend/UI Edge Cases

- Some Google Ads accounts return no descriptive name from Google. The UI must
  not present this as a platform bug.
- Some accounts are closed/suspended and cannot return performance.
- Google OAuth app verification may still show Google's external warning. The
  platform can explain it but cannot remove it from UI code alone.
- Manager accounts should not be used for metrics.
- Sync can take seconds because it calls Google Ads API; UI must reflect that.

## Acceptance Checklist

The UI/UX pass is not done until:

- Landing page looks like a real SaaS homepage.
- First-time user understands where to click.
- Returning user does not feel forced through setup from scratch.
- Account switcher works elegantly with many accounts.
- Account selection and sync show immediate loading.
- Unnamed accounts are explained and can be renamed locally.
- Dashboard has clear hierarchy and selected account context.
- Sidebar/navigation remains stable.
- Assistant page has strong prompts and real loading/error states.
- Arabic is consistent.
- Mobile layout is usable.
- `tsc --noEmit` passes.
- `next build` passes.
- No secrets are printed or committed.

## Claude Implementation Prompt

Paste this into Claude after giving it repo access:

```text
You are taking over UI/UX implementation for Moodaaft Ads AI in:
/Users/aimanamin/Documents/GitHub/modaafa

Read CLAUDE-UI-UX-HANDOFF-2026-07-06.md fully first. Then inspect the UI files
listed there. Your job is to redesign and polish the product UI/UX without
breaking the existing Google Ads/OAuth/backend logic.

Prioritize:
1. Dashboard shell + account switcher
2. Onboarding flow
3. Landing/login
4. Assistant/audit/campaigns/settings polish
5. Loading/error/empty states everywhere

Keep Arabic-first RTL. Make it feel like a premium operational SaaS for Google
Ads management. Use existing Tailwind/lucide-react. Do not expose or touch
secrets. Do not change backend logic unless strictly necessary for a UI state.

Before finalizing, run:
export PATH="/Users/aimanamin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/next build

Return a concise Arabic summary with:
- what changed
- files touched
- how to test
- any remaining UI/UX concerns
```

