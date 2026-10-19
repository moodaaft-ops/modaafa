# Growth: Demand Gen, audiences, experiments, image assets (items 37, 38, 18)

Branch `feat/mb2-video` (from `feat/mb-integration` d3bce07). Four new flags, all off by default and
read as on only when the value is exactly `true`. With all four off, every changed file behaves as before
(`tests/growth-flags-parity.test.ts`).

| Flag | Gates |
|---|---|
| `DEMAND_GEN_ENABLED` | `launch_demand_gen`, and `attach_audience` together with the audiences flag |
| `AUDIENCES_ENABLED` | `create_user_list`, `attach_audience` |
| `EXPERIMENTS_ENABLED` | `create_experiment`, `end_experiment`, `promote_experiment` |
| `IMAGE_ASSETS_ENABLED` | `create_image_assets` |

No migration. Cards are ordinary `recommendations` rows and the executed action goes into `ai_actions` as before.

## How it plugs in

One registry (`lib/growth`) instead of four wiring patches. Every operation follows the existing path:
card (`action_payload {operation, target_id, params}`) then `buildExecutableAction` (validates the stored params,
injects the account id, null when the flag is off) then `prepareActionForExecution` then `checkGuardrails`
(shadow-account block applies) then `executeAction` (validateOnly, then live) then readback then
`finalizeRollbackPayload` and the undo through `executeRollback` after `rollbackResourcesScoped`.
Touched existing files: `executable-action.ts`, `execution-preflight.ts`, `execution-result.ts`,
`optimizer-agent.ts` (type union, executeAction, executeRollback), `operation-labels.ts`, the optimizer page
(preview rows and labels), `google-ads/client.ts` (experiment REST helpers), `.env.example`.
Proposals: `POST /api/growth/propose` with `kind` = demand_gen, user_list, experiment, end_experiment,
promote_experiment, image_assets (same origin, rate limit, 404 when the kind's flag is off).

## Item 37: Demand Gen and audiences

- `lib/demand-gen`: pure plan builder with blockers, stored-plan validation, operation builder, executor.
  Built in one atomic mutate: budget, campaign (PAUSED, DEMAND_GEN, Display closed), ad group, location and
  language criteria, optional audience, then `DemandGenMultiAssetAd`, or a YouTube video asset plus
  `DemandGenVideoResponsiveAd` when the merchant gives a video id (watch, short and youtu.be links parsed;
  an existing asset for the id is linked, not duplicated). Landing page must be on the merchant's own site.
  Copy goes through the Search launcher's cleaning (limits, phone numbers, caps); bad lines are removed and reported.
- Guardrails (refuse, at proposal and again at execution): conversion tracking verdict `healthy` (same verdict as
  the optimizer), SAR account, minimum daily budget SAR 20 (product floor, Google recommends about 375), tCPA budget at least
  10 times the target, and conversion history for the strategy (Max Clicks 0, Max Conversions 10, tCPA 50 in 30 days;
  the 10 is a product floor, 50 follows the Titan reference). Images must exist as IMAGE assets that fit their slot.
  A campaign that reads back not PAUSED is paused again.
- Undo: removes campaign and budget through the Search launcher's undo (refuses while the campaign is enabled).
  Assets and the audience are retained (the API cannot delete them).
- Enabling stays the existing `enable_campaign` card; nothing here spends.
- Remarketing: `create_user_list` builds a website-visitors rule list (URL contains host, 1 to 540 days, default 30,
  prepopulation requested). `attach_audience` wraps a list in an Audience and attaches it to a Demand Gen ad group
  that uses grouped audiences; refused under 100 members. Undo removes the criterion. Lists are never deleted
  (undo of a list closes it).
- Customer Match: SHA-256 hashing with Saudi E.164 phone and lowercase email normalization (gmail dots and plus tags
  removed), dedupe, 100 minimum, 10k chunks, consent and terms confirmations required, hashes only in requests.
  The transport is an interface; the default `NO_TRANSPORT` throws. Creating the empty CRM list is available;
  the upload is deliberately not wired (see below).
- Customer Match policy eligibility: stated, not guessed. Google decides eligibility per account when you upload
  (account history and spend, clean policy record) and we do not call anything to infer it. The merchant must
  confirm their customers consented (Saudi PDPL) and that their privacy policy covers sharing. See
  `CUSTOMER_MATCH_POLICY_AR`.

## Item 38: Experiments

- `lib/experiments`: plan with pure guardrails, significance helper, results reader, executors.
- Create: experiment (SETUP, validateOnly first), two arms (control and treatment, split 20 to 50), the ONE change
  applied to the treatment draft campaign (bidding strategy or the ad final URL), validateOnly schedule, live schedule.
  Any failure before the live schedule removes the half-built experiment. Undo of a created experiment ends it.
- Guardrails: SEARCH only, campaign ENABLED, no overlapping experiment, tracking healthy, campaign has at least 15
  conversions in 30 days, no portfolio strategy, duration chosen so each arm can reach about 50 conversions after the
  7-day learning week (28 to 84 days), refused if it cannot. Start date is tomorrow in the account zone; a card whose
  date passed before approval is refused (re-propose).
- Verdict (`significance.ts`): first 7 days dropped, at least 14 days after that, at least 30 conversions in each arm,
  winner only at p < 0.05 (two-proportion z-test on conversion rate for landing page tests; conditional binomial z-test
  on conversion share by spend, which compares cost per conversion, for bidding tests). "No clear difference" needs 50 per arm.
  CTR is never used.
- End and promote are approval cards only. The promote card exists only when fresh numbers show the treatment winning,
  and the executor re-reads the results and refuses otherwise. Both are not reversible (recorded as such).

## Item 18: Image assets

- Candidates from the merchant's own landing page (guarded fetch from `lib/landing-check`): og, twitter, img, srcset
  (widest), icons. Each image is downloaded through an SSRF-guarded fetcher (https, per-hop IP check, 3 redirects,
  6 s, 5 MB, no cookies), its size read from the header bytes (PNG, JPEG, GIF, WEBP), and checked against the slots:
  marketing 1.91:1 (min 600x314), square 1:1 (min 300), portrait 4:5 (min 480x600), logo 1:1 (min 144, 150 KB);
  JPG or PNG only, 5 MB.
- Crops are proposals only (largest centered crop that still meets the minimum). Nothing is cropped or generated.
  Only images that already fit are uploaded, byte for byte.
- The card stores url, sha256, size, slot. Execution re-downloads and refuses if the hash changed, validates, creates
  the ImageAssets (name includes slot and sha8, so a repeat reuses the asset), reads back dimensions. Not reversible
  (assets cannot be deleted; an unused image asset serves nowhere).
- Video generation is out of scope. Only a YouTube id the merchant supplies is used (Demand Gen above).

## Not verified live (needs a validateOnly pass on a real account before turning the flags on)

I could not fetch the Google reference pages from this environment, so these rest on the Titan references and
my reading of the v22 API:
1. REST paths and bodies of `ExperimentService:mutate`, `:scheduleExperiment` style calls (`/{experiment}:schedule`,
   `:end`, `:promote`) and `ExperimentArmService:mutate`.
2. Demand Gen field shapes: `business_name` as plain text on the ad, `audience_setting.use_audience_grouped`,
   `exclusion_dimension` for exclude lists, location and language criteria at ad group level, 30-character headlines.
3. Website-visitors rule item (`url__` CONTAINS) and `prepopulation_status`.
4. Editing the treatment draft with `include_drafts` in GAQL, and the mutate against `inDesignCampaigns`.
5. Data Manager upload shape and OAuth scope. That is why the Customer Match upload has no live transport.
6. The `sizeForDisplay` read for list size, and the status strings after `promote`.
validateOnly is the safety net on every live path; a shape error fails there before anything is written.

## Open decisions for Ayman

- Turn on order: image assets and user lists first (smallest blast radius), then experiments, then Demand Gen.
- Customer Match upload: needs a Data Manager API enablement and scope decision before a transport is written.
- Region lookup for Demand Gen cards is not wired in the propose route (plan defaults to Saudi Arabia as a whole,
  region names would need the geo suggest call the Search launcher uses).
- Minimum budget SAR 20 and the 10 conversion floor for Max Conversions are product choices, change in
  `lib/demand-gen/plan.ts` and `lib/growth/readiness.ts`.
- No UI for starting proposals yet; the route and cards exist, the card preview shows on the optimizer page.

## Tests

83 new tests in `tests/growth-*.test.ts` (demand gen 21, experiments 23, audiences 17, image assets 13, flags and
parity 9). Full run: 2916 tests, 2867 pass, 0 fail, 49 skipped (baseline 2833 / 2784 / 49). `tsc --noEmit` and
`eslint . --max-warnings=0` clean.

## Files

`lib/growth/*`, `lib/demand-gen/*`, `lib/audiences/*`, `lib/experiments/*`, `lib/image-assets/*`,
`app/api/growth/propose/route.ts`, `tests/growth-*.ts`, plus the edits listed under "How it plugs in".
