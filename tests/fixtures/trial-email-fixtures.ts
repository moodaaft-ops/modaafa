/**
 * Pinned fixtures for the trial email normalisation.
 *
 * `lib/billing/trial-identity.ts` (TypeScript) and `public.trial_email_key` in
 * db/migrations/20261013_trial_abuse_guards.sql (SQL) must agree on every row.
 * `key` is sha256 (hex) of `normalized`; the values below were produced by the
 * TypeScript implementation and cross-checked with `printf '<normalized>' | sha256sum`.
 *
 * To check the SQL by hand on a scratch database:
 *   select public.trial_email_key('John.Doe+test@Gmail.com');
 *   -- expect 06a240d11cc201676da976f7b49341181fd180da37cbe40a77432c0a366c80c3
 * tests/trial-abuse-sql.integration.test.ts runs every row against Postgres when
 * TRIAL_ABUSE_PG_URL is set.
 */
export type TrialEmailFixture = {
  input: string;
  normalized: string;
  key: string;
};

export const TRIAL_EMAIL_FIXTURES: TrialEmailFixture[] = [
  {
    input: 'Owner@Example.com',
    normalized: 'owner@example.com',
    key: 'c8cd3c6427301eaf6665bccacd65ddb614527acc843a15463e3faba57124c351',
  },
  {
    input: '  owner@example.com ',
    normalized: 'owner@example.com',
    key: 'c8cd3c6427301eaf6665bccacd65ddb614527acc843a15463e3faba57124c351',
  },
  {
    input: 'owner+promo@example.com',
    normalized: 'owner@example.com',
    key: 'c8cd3c6427301eaf6665bccacd65ddb614527acc843a15463e3faba57124c351',
  },
  {
    input: 'John.Doe+test@Gmail.com',
    normalized: 'johndoe@gmail.com',
    key: '06a240d11cc201676da976f7b49341181fd180da37cbe40a77432c0a366c80c3',
  },
  {
    input: 'johndoe@gmail.com',
    normalized: 'johndoe@gmail.com',
    key: '06a240d11cc201676da976f7b49341181fd180da37cbe40a77432c0a366c80c3',
  },
  {
    input: 'j.o.h.n.d.o.e@googlemail.com',
    normalized: 'johndoe@gmail.com',
    key: '06a240d11cc201676da976f7b49341181fd180da37cbe40a77432c0a366c80c3',
  },
  {
    // Dots are only insignificant on Gmail.
    input: 'john.doe@example.com',
    normalized: 'john.doe@example.com',
    key: '836f82db99121b3481011f16b49dfa5fbc714a0d1b1b9f784a1ebbbf5b39577f',
  },
  {
    // Everything from the FIRST plus goes.
    input: 'a+b+c@example.com',
    normalized: 'a@example.com',
    key: '08168cd80dfd534ab0f10af10f1303fe00af2d43ab5c1432360d137f8197e17a',
  },
  {
    // A tag with no local part in front of it is not stripped.
    input: '+tag@example.com',
    normalized: '+tag@example.com',
    key: '4faaa023b91b71430c90fe9b49d10e1631ffd65974d0afb4478dcbab1f6212c1',
  },
  {
    // The split is on the LAST at-sign.
    input: 'x@y@example.com',
    normalized: 'x@y@example.com',
    key: 'e16cb94c25de9d0cdae5a32c494ac80876a6a677ba05be1d02c490b313768d15',
  },
  {
    input: 'no-at-sign',
    normalized: 'no-at-sign',
    key: 'ec2124034dd559ba7864a1dcf4e496fd60809e6c9692c8239fa106c7d7b1fd4b',
  },
];
