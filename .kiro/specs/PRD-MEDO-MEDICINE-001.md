---
prd_id: PRD-MEDO-MEDICINE-001
title: Medicine Service — Medicine Catalog and private Medicine records
application: Medo
component: Medicine
profile: backend-microservice
version: "1.0"
status: approved
author: Devin
approver: Sir Asim
approval_date: 22-11-26 04-52-28 UTC
upstream:
  feature_list: docs/features/feature-list.md@2026-11-20
  service_catalog: docs/contracts/service-catalog.md@2026-11-22
  glossary: GLOSSARY.md@2026-11-21
  architecture_standard: docs/architecture/MicroservicesApps-Architecture-Standard.md
downstream: [HLD, LLD, tasks]
hld_readiness: pass
supersedes: none
superseded_by: null
---

# PRD-MEDO-MEDICINE-001: Medicine Service — Medicine Catalog and private Medicine records

## 1. Problem statement

Medo's core domain object is the **Medicine**: what a **Patient** (or their linked **Caregiver**) is taking, in what dosage, and how many doses remain before a refill is needed. Every dose, schedule, reminder, and points calculation hangs off a Medicine record, and every "add medicine" flow starts from identifying the drug itself.

Current state: none — greenfield build; there is no workaround in production. The cost of getting this wrong is high: a broken catalog forces every patient to hand-type drug identities (duplicate, misspelled entries); a broken Doses Remaining counter silently corrupts refill alerts; a broken photo flow blocks medicine registration entirely (photos are required); a wrong delete-check either destroys dose history or traps users with undeletable records.

Quantification: not applicable at hackathon scale — catalog ceiling is <10,000 entries and dose events <5,000/day (`platform-quality-baseline.md`). The binding constraint is correctness of the two-aggregate split (shared catalog vs private record), idempotent Doses Remaining tracking, and the fail-closed delete check — not throughput.

Trace: `docs/features/feature-list.md` §§3, 4, 8 (authorization parity, medicine registration, refill tracking), Map 1 tickets 03/04/08, Map 2 tickets 03/07, Map 3 tickets 04/09.

## 2. Goals and non-goals

### 2.1 Goals

- G-1: Any authenticated user can browse, search, and view Medicine Catalog entries with photos, so patients never hand-enter drug identities. [§1]
- G-2: Any authenticated user can add a catalog entry when a drug is missing; creation performs a duplicate-check on brand + form + ingredient set and offers the existing match instead of a silent duplicate. [§1]
- G-3: Catalog fields and photos are community-editable by any authenticated user (last write wins); entries are never owned and survive account deletion. [§1]
- G-4: A Patient (or linked Caregiver) can adopt a catalog entry into a private Medicine record capturing prescribing doctor, dosage, doses remaining, price, and pharmacy name. [§1]
- G-5: Photo upload works as a two-step signed-URL flow: request upload slot → direct-to-bucket PUT → confirm attach, with unguessable keys on a public-read bucket. [§1]
- G-6: Doses Remaining auto-adjusts on every dose outcome change (idempotent, floor 0) and on manual edits, and `RefillThresholdCrossed` fires exactly on the per-medicine `refillThreshold` (default 6) / re-arm / 0 transitions. [§1]
- G-7: A Medicine can be archived (history kept) or hard-deleted only when Schedule & Dose confirms zero dose records — fail closed when the check is unreachable. [§1]
- G-8: `AccountDeleted` purges a user's private Medicine records only; shared catalog entries and catalog photos survive. [§1]

### 2.2 Non-goals

- NG-1: Schedules, RRULE, dose occurrences/outcomes, dose windows, missed-lock — owned by Schedule & Dose Service (Map 2 ticket 04).
- NG-2: Reminder delivery, refill push/email/feed composition — owned by Notification Service; Medicine only publishes `RefillThresholdCrossed`.
- NG-3: Harmony Points / theme state — owned by Gamification Service (Map 2 ticket 06).
- NG-4: User accounts, profiles, sessions — owned by Identity Service.
- NG-5: Care Link state — owned by Care Service; Medicine only consumes `check-link` answers via the platform authz pattern.
- NG-6: Catalog moderation, ownership, or per-user catalog permissions — community-editable by design (Map 2 ticket 07); no reviewer role exists.
- NG-7: Medicine purchase history, reorder workflow, supplier management, per-user refill settings — explicitly rejected as out of v1 scope (Map 1 ticket 08). NOTE 2026-11-26: per-medicine `refillThreshold` (custom alert level, not a per-user setting) was user-approved and added — see FR-MED-011/021 and OQ-MED-06.
- NG-8: Offline photo caching permanence — IndexedDB caching is client-side behavior per `frontend-map.md`, not a service contract.
- NG-9: Un-archiving, catalog-entry deletion, or catalog merge/dedup tooling — no contract exists; catalog entries are permanent (Map 2 ticket 07).
- NG-10: HLD/LLD/implementation — downstream artifacts per Architecture Standard.

## 3. Users, actors, and roles

| Actor | Role (glossary term) | Acts on behalf of | Authz requirement summary |
|---|---|---|---|
| Patient | Patient | self | Full catalog read/write; own Medicines CRUD/archive/delete where `patientId` = own userId |
| Caregiver | Caregiver | linked Patient | Same catalog access; patient-scoped Medicine routes only via active Care Link (`check-link` per request) |
| Medo service | internal service caller | the service's own operations | `GET /v1/medicines/{id}` with a valid internal service token (e.g. Notification composing reminder text); never with a user token |
| Schedule & Dose service | internal service caller | Medo platform | Answers `GET /v1/patients/{id}/has-dose-records` for the delete check; publishes `DoseOutcomeChanged` which Medicine consumes |
| Notification service | event consumer | Medo platform | Consumes `RefillThresholdCrossed`; resolves recipients via Care `patients/{id}/links`; not a REST caller of Medicine |
| Identity service | upstream provider | Medo platform | Publishes `AccountDeleted` which Medicine consumes; Medicine makes no directory calls |
| System | event consumer | Medo platform | Consumes `DoseOutcomeChanged` (every outcome change) and `AccountDeleted` via `broker_db` |

## 4. User stories / capability inventory

Service-scoped stories (backend profile §4):

- US-MED-01: As an authenticated user, I want to browse and search the Medicine Catalog so that I can find a drug without typing its identity from scratch. [FR-MED-001…003]
- US-MED-02: As an authenticated user, I want to add a missing catalog entry so that the community catalog grows. [FR-MED-004, 005]
- US-MED-03: As an authenticated user, I want to fix catalog data (fields, photos) so that entries stay accurate for everyone. [FR-MED-006, 007…010]
- US-MED-04: As a Patient or linked Caregiver, I want to adopt a catalog entry into my private Medicine record so that I can track my own dosage, price, and stock. [FR-MED-011…015]
- US-MED-05: As a Patient or linked Caregiver, I want to archive or delete a Medicine so that I can retire it without losing history. [FR-MED-016, 017]
- US-MED-06: As the platform, I want Doses Remaining to follow dose outcomes automatically so that refill alerts stay truthful without manual recounting. [FR-MED-019…023]
- US-MED-07: As the platform, I want refill threshold crossings published as events so that Notification can alert the patient and caregivers. [FR-MED-022]
- US-MED-08: As the platform, I want account deletion to purge private records while preserving the shared catalog so that community data is never destroyed by one user's departure. [FR-MED-024]

## 5. Functional requirements

### 5.1 Catalog browse & read

- FR-MED-001: WHEN `GET /v1/medicine-catalog?q=&page=` is called under any valid session, the Medicine service SHALL return a paginated list of catalog entries matching `q` as a text match on brand name and ingredient names, and SHALL return the full list (paginated) when `q` is absent. [US-MED-01]
  - AC-MED-001a: response DTOs contain catalog fields + resolved photo URLs only — no internal fields — verification: contract test.
  - AC-MED-001b: (negative) unauthenticated or invalid-token calls are rejected — verification: contract test.
- FR-MED-002: WHEN `GET /v1/medicine-catalog/{id}` is called under any valid session for an existing entry, the Medicine service SHALL return the entry detail including all three photo slots resolved per the gap-fill rule (FR-MED-003). [US-MED-01]
  - AC-MED-002a: unknown id returns not-found — verification: contract test.
- FR-MED-003: The Medicine service SHALL resolve each photo slot A/B/C on read with the gap-fill rule: a slot with no stored photo falls back to the next-most-relevant stored photo (C→B→A, B→A); slots with no resolvable photo return empty. [US-MED-01, US-MED-03]
  - AC-MED-003a: entry with only slot A stored returns A's photo for all three slots — verification: unit test.
  - AC-MED-003b: entry with zero stored photos returns empty photo fields — verification: unit test.

### 5.2 Catalog create & community edit

- FR-MED-004: WHEN `POST /v1/medicine-catalog` is called under any valid session with `{brandName, ingredientNames[], form, packagingQuantity}`, the Medicine service SHALL create a shared catalog entry and return it. [US-MED-02]
  - AC-MED-004a: created entry is immediately visible to all sessions in browse/search — verification: integration test.
  - AC-MED-004b: `ingredientNames` accepts multiple entries (combination drugs); `form` ∈ tablet/capsule/syrup/injection/drops/other — verification: contract test.
- FR-MED-005: WHEN `POST /v1/medicine-catalog` is called, the Medicine service SHALL run the duplicate-check on brand name + form + ingredient set; IF a match exists, THEN it SHALL reject with a conflict response carrying the existing entry's identity so the client can offer it instead. [US-MED-02]
  - AC-MED-005a: exact-set duplicate returns conflict + existing entry reference, no second entry created — verification: integration test.
  - AC-MED-005b: (negative) differing ingredient set or form does not conflict — verification: integration test.
  - AC-MED-005c: duplicate-check comparison is case/whitespace-normalized — verification: unit test.
- FR-MED-006: WHEN `PATCH /v1/medicine-catalog/{id}` is called under any valid session, the Medicine service SHALL apply the field changes last-write-wins with no ownership check and no versioning; photo slots change only via the photo routes (FR-MED-007…010). [US-MED-03]
  - AC-MED-006a: two sequential edits both persist; second wins — verification: integration test.
  - AC-MED-006b: (negative) unknown id rejected; malformed field values rejected — verification: contract test.

### 5.3 Photo upload (two-step signed URL)

- FR-MED-007: WHEN `POST /v1/medicine-catalog/{id}/photos` is called under any valid session with `{slot: A|B|C}` for an existing entry, the Medicine service SHALL return `{photoKey, uploadUrl}` where `uploadUrl` is a short-lived signed PUT URL targeting the R2 bucket and `photoKey` is an unguessable object key scoped to that entry+slot. [US-MED-03]
  - AC-MED-007a: presigned URL generation is local (no R2 call); expiry is short-lived — verification: unit test.
  - AC-MED-007b: (negative) unknown entry id or invalid slot rejected — verification: contract test.
- FR-MED-008: The client SHALL upload photo bytes by direct HTTP PUT to `uploadUrl` (bypassing the service); the bucket is public-read so uploaded objects are fetchable by key without signing. [US-MED-03]
  - AC-MED-008a: service performs no byte proxying — verification: architecture review.
- FR-MED-009: WHEN `PUT /v1/medicine-catalog/{id}/photos/{slot}` is called under any valid session with `{photoKey}`, the Medicine service SHALL attach the uploaded object to that slot after verifying the key was issued for this entry+slot, replacing any prior photo in that slot. [US-MED-03]
  - AC-MED-009a: valid confirm makes the photo visible on subsequent reads (gap-fill aware) — verification: integration test (R2 stubbed).
  - AC-MED-009b: (negative) a `photoKey` issued for a different entry/slot, an unknown key, or an unexpired-but-never-uploaded key is rejected — verification: integration test.
- FR-MED-010: IF the attach-confirm cannot verify the object exists in the bucket (R2 timeout/error), THEN the Medicine service SHALL fail closed — reject the confirm and leave the prior slot photo unchanged. [US-MED-03]
  - AC-MED-010a: simulated R2 failure → 5xx, slot unchanged, no partial state — verification: integration test.

### 5.4 Private Medicine records

- FR-MED-011: WHEN `POST /v1/medicines` is called under a Patient session (patientId = own userId) or a linked-Caregiver session (patientId = linked patient), the Medicine service SHALL create a private Medicine record adopting `catalogEntryId` plus `{prescribingDoctor, dosage, dosesRemaining, refillThreshold?, price, pharmacyName}`, with `dosesRemaining` a required whole number ≥ 0 and `refillThreshold` an optional whole number ≥ 0 defaulting to 6 when omitted. The service SHALL reject adoption when the catalog entry has zero confirmed photos — at least one photo slot must be populated before a Medicine can be registered (photo requirement enforced at adopt because photo keys require an existing entry id). [US-MED-04]
  - AC-MED-011a: record stores catalogEntryId link; catalog fields are resolved via join at read time, never copied — verification: unit test.
  - AC-MED-011b: missing/negative/non-integer `dosesRemaining` rejected — verification: contract test.
  - AC-MED-011c: unknown `catalogEntryId` rejected — verification: contract test.
  - AC-MED-011d: catalog entry with zero confirmed photos → adopt rejected, directing user to add a photo first — verification: integration test.
- FR-MED-012: The Medicine service SHALL treat "unknown medicine" as a two-call client flow — `POST /v1/medicine-catalog` first, then `POST /v1/medicines` with the returned id; the service SHALL NOT auto-create catalog entries inside the adopt call. [US-MED-02, US-MED-04]
  - AC-MED-012a: adopt with nonexistent catalogEntryId fails; no private record created — verification: integration test.
- FR-MED-013: WHEN `GET /v1/medicines?patientId=` is called, the Medicine service SHALL return that patient's Medicine list (private fields + catalog summary) after authz: patient-self, or linked caregiver via Care `check-link`. [US-MED-04]
  - AC-MED-013a: (negative) session for a different patient and no active link → denied — verification: contract test.
  - AC-MED-013b: archived medicines are excluded from the default list but retrievable (FR-MED-014 detail still resolves them) — verification: integration test.
- FR-MED-014: WHEN `GET /v1/medicines/{id}` is called under patient-self, linked-caregiver, or Medo-service authz, the Medicine service SHALL return the private record with catalog fields resolved via `catalogEntryId` (photo slots per FR-MED-003). [US-MED-04]
  - AC-MED-014a: response merges private + catalog DTOs; catalog-deleted-impossible (entries never deleted) — verification: contract test.
- FR-MED-015: WHEN `PATCH /v1/medicines/{id}` is called under the same authz as FR-MED-013, the Medicine service SHALL apply changes to private fields including `dosesRemaining` and `refillThreshold`, and SHALL evaluate refill-threshold transitions (FR-MED-021…023) whenever `dosesRemaining` or `refillThreshold` changes. [US-MED-04, US-MED-06]
  - AC-MED-015a: manual edit to ≤6 from >6 emits `RefillThresholdCrossed` threshold=6 — verification: integration test.
  - AC-MED-015b: (negative) edit on archived medicine rejected or limited to permitted fields — verification: contract test. (See OQ-MED-01 note: archived-medicine edit semantics pending.)
- FR-MED-016: WHEN `POST /v1/medicines/{id}/archive` is called under the same authz, the Medicine service SHALL mark the record archived, retaining all history, and SHALL publish `MedicineArchived` with payload `{medicineId, patientId}` so Schedule & Dose stops dose generation for that medicine's schedules (existing Dose rows remain as history). [US-MED-05]
  - AC-MED-016a: archive is idempotent — repeat archive returns success/no-op without error and emits no duplicate event — verification: integration test.
  - AC-MED-016b: archived record's dose history and Doses Remaining remain readable — verification: integration test.
  - AC-MED-016c: exactly one `MedicineArchived` per archive transition — verification: contract test.
- FR-MED-017: WHEN `DELETE /v1/medicines/{id}` is called under the same authz, the Medicine service SHALL first call Schedule & Dose `GET /v1/patients/{id}/has-dose-records` synchronously; IF dose records exist, THEN reject directing the user to archive; IF none exist, THEN hard-delete the record; IF the check is unreachable/times out, THEN fail closed and refuse the delete. [US-MED-05]
  - AC-MED-017a: has-dose-records=true → delete refused — verification: integration test (Schedule & Dose stubbed).
  - AC-MED-017b: check timeout/error → delete refused with retryable error — verification: integration test.
  - AC-MED-017c: successful delete removes private record + its dose-outcome tracking rows + outbox references; catalog entry untouched — verification: integration test.

### 5.5 Doses Remaining & refill events

- FR-MED-018: The Medicine service SHALL track, per private Medicine, the last-applied outcome for every dose occurrence it has seen, keyed by `doseId`, enabling delta computation on `DoseOutcomeChanged` redelivery or out-of-order arrival within the at-least-once model. [US-MED-06]
  - AC-MED-018a: redelivery of an identical outcome event is a no-op — verification: integration test.
- FR-MED-019: WHEN the Medicine service consumes `DoseOutcomeChanged` `{doseId, medicineId, patientId, outcome, actorId?, occurredAt}`, it SHALL compute the delta on the target Medicine's `dosesRemaining`: transition into a Taken-class outcome (`taken-on-time`, `taken-late`) decrements by 1; transition out of Taken-class increments by 1; same-class or first-seen-Taken-class-not previously counted → decrement only on actual not-Taken→Taken transition; `skipped`, `missed`, snooze (no event), and plan-skip (no event) never change the count. [US-MED-06]
  - AC-MED-019a: Taken→skipped edit before midnight restores +1 — verification: integration test.
  - AC-MED-019b: (negative) `skipped`/`missed` outcomes never decrement — verification: integration test.
  - AC-MED-019c: floor 0 — decrement at 0 stays 0 — verification: unit test.
- FR-MED-020: The Medicine service SHALL apply Doses Remaining deltas for outcome edits up to the Schedule & Dose midnight missed-lock; after lock, outcomes are immutable upstream so no further events arrive for that dose. [US-MED-06]
  - AC-MED-020a: late-arriving event for an already-locked dose still applies its delta once (event carries final state) — verification: integration test.
- FR-MED-021: The Medicine service SHALL evaluate refill-threshold state on every `dosesRemaining` change (event-driven or manual): each Medicine carries a per-medicine `refillThreshold` (user-settable, default 6); emit `RefillThresholdCrossed` with `threshold=<refillThreshold>` on the first transition into `dosesRemaining ≤ refillThreshold` and again only after the value rises above `refillThreshold` and re-crosses; emit `threshold=0` on each transition into 0 regardless of `refillThreshold` (empty-stock alert is mandatory), re-arming when the value rises above 0 (symmetric re-arm — a genuine refill may deplete again). When both thresholds qualify simultaneously, emit the deepest (0). [US-MED-06, US-MED-07]
  - AC-MED-021a: manual edit 10→5 on a default-threshold medicine emits threshold=6 once; edit 5→5 emits nothing — verification: integration test.
  - AC-MED-021b: 5→8→4 re-arms and emits a second threshold=6 — verification: integration test.
  - AC-MED-021c: medicine with `refillThreshold=10` edited 12→9 emits threshold=10; same medicine at 5 emits threshold=0 (deepest wins) — verification: integration test.
  - AC-MED-021c: reaching 0 emits threshold=0 (final alert) — verification: integration test.
- FR-MED-022: WHEN a threshold transition fires, the Medicine service SHALL publish `RefillThresholdCrossed` with payload `{medicineId, patientId, dosesRemaining, threshold}` (`threshold` = the medicine's `refillThreshold` value or 0) in the `{eventId, occurredAt}` envelope; recipient resolution (Patient + linked Caregivers) is Notification's concern via Care `patients/{id}/links`. [US-MED-07]
  - AC-MED-022a: exactly one event per qualifying transition; payload carries IDs + changed fields only — verification: contract test.
- FR-MED-023: The Medicine service SHALL maintain per-medicine refill-alert arm state (whether the `refillThreshold` and 0 alerts are currently armed) so repeat evaluations do not double-fire; arm state resets when `dosesRemaining` rises above the respective threshold per FR-MED-021. [US-MED-06]
  - AC-MED-023a: service restart preserves arm state (persisted, not in-memory) — verification: integration test.

### 5.6 Internal read, deletion & authz

- FR-MED-024: WHEN the Medicine service consumes `AccountDeleted` for a user, it SHALL purge that user's private Medicine records and their dose-outcome tracking rows; it SHALL NOT modify any Medicine Catalog entry or catalog photo. [US-MED-08]
  - AC-MED-024a: after processing, the user's medicines are gone from all reads; catalog entries created-by-others remain — verification: integration test.
  - AC-MED-024b: consumption is idempotent — redelivery finds nothing to purge — verification: integration test.
- FR-MED-025: The `GET /v1/medicines/{id}` route SHALL serve both public authz (patient-self / linked caregiver) and internal authz (Medo service token, e.g. `aud=medo-medicine`); a user token SHALL NOT satisfy the internal path and a service token SHALL NOT satisfy patient-scoped list routes. [US-MED-04]
  - AC-MED-025a: (negative) cross-token-class calls rejected — verification: contract test.
- FR-MED-026: The Medicine service SHALL authorize every patient-scoped route (`/v1/medicines*`) server-side per request: patient-self when `patientId`/record owner equals session `sub`, else Care `check-link` for caregiver sessions; the frontend is never trusted for authz. [US-MED-04, US-MED-05]
  - AC-MED-026a: caregiver with active link gets parity; caregiver without link denied — verification: contract test (Care stubbed).
  - AC-MED-026b: check-link denial or Care-unreachable → deny (fail closed); the consumer-side 15 s positive cache (Map 3 t09) is the only grace window — verification: integration test.
- FR-MED-027: Catalog routes (`/v1/medicine-catalog*`) SHALL require only a valid session — any role (Patient or Caregiver) may browse, add, and community-edit; catalog authz SHALL NOT consult Care `check-link`. [US-MED-01…03]
  - AC-MED-027a: (negative) unauthenticated catalog calls rejected; caregiver session catalog write succeeds — verification: contract test.

## 6. Non-functional requirements

| NFR-ID | Category | Metric + threshold + condition | Source/justification |
|---|---|---|---|
| NFR-MED-01 | performance/latency | Public reads (`GET /v1/medicine-catalog*`, `GET /v1/medicines*`) p95 < 300 ms; public writes (catalog create/edit, photo confirm, medicine create/edit/archive/delete) p95 < 500 ms; internal `GET /v1/medicines/{id}` p95 < 200 ms | `platform-quality-baseline.md` route classes |
| NFR-MED-02 | availability/reliability | ~99% during hackathon period; dependency failure returns clean 4xx/5xx JSON, never crash/hang; own-DB failure → 503 | `platform-quality-baseline.md` |
| NFR-MED-03 | scalability | < 50 concurrent users; catalog < 10,000 entries; `DoseOutcomeChanged` consumption < 5,000 events/day; single instance on EC2 `t3.micro` | `platform-quality-baseline.md` load envelope |
| NFR-MED-04 | security/authz | Catalog writes + patient-scoped routes session-gated; patient data via `check-link` per request; photo keys unguessable + slot-scoped confirm; presigned PUT short-lived; per-route rate limits per Map 3 t09 (public 30/min/IP, auth'd writes 60/min/userId, reads 300/min/user) | Map 2 t07, Map 3 t04/09 |
| NFR-MED-05 | data/privacy | `prescribingDoctor`, `price`, `pharmacyName`, `patientId` linkage = health-adjacent PII; private records + tracking rows purged on `AccountDeleted`; catalog entries + photos retained by design; no backups in v1 (accepted risk) | `platform-quality-baseline.md` retention table |
| NFR-MED-06 | observability | Pino JSON logs + `X-Request-Id`/`eventId` correlation; `GET /metrics` RED + custom counters (catalog creates/edits, duplicate-check conflicts, photo confirms, medicines created/archived/deleted, delete-check refusals, doses-remaining deltas, threshold events, `DoseOutcomeChanged`/`AccountDeleted` consumed); Sentry project `medo-medicine`; `/health` public, `/ready` checks own DB + `broker_db` | `platform-observability.md` + PRD deltas |

† Offline/resilience and accessibility NFR categories are frontend-profile only — not applicable to this backend PRD.

### 6.1 Scaling & operational needs

- Load profile: catalog browse/search is the highest-volume read (<10k entries — a single table scan + text match is sufficient at this envelope; no search engine). `DoseOutcomeChanged` consumption tracks dose-event volume (<5k/day). All volumes sit far below the platform envelope.
- Scheduled jobs: **none** — Medicine has zero jobs per `scheduled-jobs.md`; all behavior is request-driven or event-driven (`RefillThresholdCrossed` emission on Doses Remaining change). No deltas.
- Statefulness: catalog entries, private Medicine records, per-dose last-outcome rows, refill arm state, and the outbox live in own `medicine_db`; rate-limit counters in-memory per Map 3 t09; check-link positive cache ~15 s consumer-side per Map 3 t09.
- Health: `GET /health` public liveness; `GET /ready` internal readiness checking own Postgres DB + `broker_db` reachability (publisher + two event consumers).
- Deployment independence: independently containerized per Architecture Standard; runtime couplings are Schedule & Dose `has-dose-records`, Care `check-link`, R2 object storage, and `broker_db` event transport — all declared in §10/§11.

## 7. Scope boundaries

### 7.1 In scope

- Medicine Catalog: browse/search/detail, community create with duplicate-check, community field edit, two-step photo upload + gap-fill resolution.
- Private Medicine records: adopt-from-catalog create, list/detail (catalog-resolved), edit incl. `dosesRemaining`, archive, guarded hard delete.
- Doses Remaining: event-driven delta tracking (idempotent, floor 0) + manual-edit path + refill arm state.
- `RefillThresholdCrossed` publication on ≤6/re-arm/0 transitions.
- `DoseOutcomeChanged` + `AccountDeleted` consumption; internal `GET /v1/medicines/{id}` for Medo services.
- Patient-self vs linked-caregiver authz via Care `check-link`; session-only catalog authz.

### 7.2 Out of scope

- Schedules, dose rows, outcome classification, dose windows, generation/missed-lock jobs — Schedule & Dose Service.
- Refill alert delivery (push/email/feed), recipient mapping — Notification Service.
- Reminder text composition — Notification consumes `GET /v1/medicines/{id}`; Medicine serves the read only.
- Harmony Points/theme — Gamification Service.
- User identity/profile — Identity Service.
- Care Link lifecycle — Care Service.
- Catalog moderation, ownership, dedup tooling, entry deletion, un-archive — rejected/none in Map 2 t07 (see §2.2).
- Offline caching of catalog/medicines — client-side Dexie concern per `frontend-map.md` (medicine display data cached; catalog browsing API-only).
- HLD/LLD/implementation → downstream artifacts per Architecture Standard.

### 7.3 Dependencies on locked decisions

- `docs/features/feature-list.md` §§3, 4, 8 — caregiver parity authz, 9-field medicine model (split per catalog amendment), refill rules (≤6, re-arm, 0, Taken-only decrement, floor 0).
- `docs/contracts/service-catalog.md` — Medicine REST surface (6 catalog + 6 patient + 1 shared internal), `RefillThresholdCrossed` publish, `DoseOutcomeChanged`/`AccountDeleted` consume, `has-dose-records` dependency.
- `docs/contracts/frontend-map.md` — Medicines list/detail/add rows; photo two-step flow; medicine display data in Dexie offline slice; catalog browsing API-only.
- `docs/architecture/platform-quality-baseline.md` — latency/availability/retention/resilience defaults (R2 row applies to photo confirm).
- `docs/architecture/platform-observability.md` — logging/metrics/health/Sentry defaults.
- `docs/architecture/scheduled-jobs.md` — Medicine job inventory = none.
- `GLOSSARY.md` — Patient, Caregiver, Medicine, Medicine Catalog, Doses Remaining, Refill alert.
- Map 3 tickets 03/04/07/09 (via `.scratch/medo-backend/`) — self-hosted Postgres + Drizzle, R2 public-read bucket + presigned PUT, Postgres outbox eventing, rate limits + check-link cache.

### 7.4 Open questions

- OQ-MED-01: ~~Archive → future-schedule-stop propagation undefined~~ — RESOLVED 2026-11-22: user approved Option A; `MedicineArchived` event added to `service-catalog.md` (Medicine publishes `{medicineId, patientId}`; Schedule & Dose consumes → stops dose generation, existing Dose rows kept as history).
- OQ-MED-02: ~~`threshold=0` refill alert re-arm semantics~~ — RESOLVED 2026-11-22: user approved symmetric re-arm (Option A) — fires on each transition into 0, re-arms above 0; FR-MED-021/023 updated.
- OQ-MED-06: ~~Fixed ≤6 refill threshold vs per-medicine custom level~~ — RESOLVED 2026-11-26: user approved custom per-medicine `refillThreshold` (whole number ≥ 0, default 6) during implementation ticket 26; threshold alert fires at the custom level, `threshold=0` empty-stock alert remains mandatory; implemented in contracts + Medicine service + frontend forms.
- OQ-MED-03: Orphan `photoKey` cleanup (issued, uploaded or not, never confirmed) — bucket lifecycle rule vs lazy sweep; no Medicine job exists per `scheduled-jobs.md`. Owner: HLD; blocks-HLD: no.
- OQ-MED-04: ~~Catalog entry with zero photos~~ — RESOLVED 2026-11-22: user approved "require ≥1 photo" (Option B); enforced at adopt — `POST /v1/medicines` rejects photo-less catalog entries (FR-MED-011/AC-MED-011d) since photo keys need an existing entry id; photo-less entries remain browsable/editable.
- OQ-MED-05: R2 public-read base URL/domain for photo fetches — env config, same domain fog as other services. Owner: user; blocks-HLD: no.

### 7.5 Service boundary statement

The Medicine Service solely owns two aggregates: the shared, community-maintained **Medicine Catalog** (brand name, ingredient names, form, tagged photos A/B/C, packaging quantity — never owned, survives `AccountDeleted`) and the private patient **Medicine** record (catalogEntryId link, prescribing doctor, dosage, doses remaining, price, pharmacy name — purged on `AccountDeleted`), plus the per-dose last-outcome tracking and refill arm state that make Doses Remaining and `RefillThresholdCrossed` correct. It does NOT own schedules/dose outcomes (Schedule & Dose Service), alert delivery (Notification Service), points/theme (Gamification Service), user accounts (Identity Service), or Care Links (Care Service). This matches the Medicine heading in `service-catalog.md`.

## 8. Edge cases and failure modes

| Edge case | Requirement/NFR mapping | Notes |
|---|---|---|
| Catalog duplicate (same brand+form+ingredient set, different case/spacing) | FR-MED-005 | Conflict returns existing entry; client offers it — no silent dupes |
| Combination drug (multiple ingredient names) | FR-MED-004, 005 | Ingredient-set comparison covers multi-name entries |
| Photo upload issued but never confirmed | §8.1, OQ-MED-03 | Orphan key in bucket; cleanup mechanism deferred to HLD |
| Photo confirm with foreign/expired key | FR-MED-009 | Key must be issued for this entry+slot |
| Photo slot emptied (no fallback available) | FR-MED-003, FR-MED-011 | Returns empty on catalog reads; adopt blocked until ≥1 photo confirmed (AC-MED-011d) |
| Adopt catalog entry that was community-edited meanwhile | FR-MED-011, 014 | Read-time resolution always shows current catalog state — no stale copy |
| `dosesRemaining` manually edited across `refillThreshold` | FR-MED-015, 021 | Threshold eval on manual path identical to event path |
| Dose outcome edited Taken→skipped before midnight | FR-MED-019 | +1 restore via last-outcome delta |
| `DoseOutcomeChanged` redelivery / out-of-order | FR-MED-018 | Last-applied outcome per doseId makes delta idempotent |
| Event for unknown medicineId (deleted account race) | FR-MED-024, §8.1 | Consumer finds no record → no-op; dead-letter only after 5 attempts |
| Medicine deleted while doses exist | FR-MED-017 | Sync has-dose-records check; fail closed on unreachable |
| Medicine deleted while Schedule & Dose down | FR-MED-017, §8.1 | Delete refused retryable — never fail open |
| Archived medicine still has future schedules | FR-MED-016, §8.1 | `MedicineArchived` → Schedule & Dose stops generation; event delivery at-least-once, consumer idempotent |
| `AccountDeleted` while `DoseOutcomeChanged` in flight | FR-MED-024 | Ordering: purge wins; late events find no record → no-op |
| Two caregivers act on same patient's medicine | FR-MED-026 | Both authorized via check-link; last-write-wins on PATCH (baseline idempotency) |
| Catalog entry created by user who later deletes account | FR-MED-024 | Entry survives — community data, never owned |
| Care check-link unavailable during patient-scoped call | FR-MED-026, §8.1 | Deny; 15 s positive consumer cache absorbs brief blips |
| `RefillThresholdCrossed` publish failure | §8.1 | Outbox retry per `@medo/eventing`; no silent loss |
| Concurrent archive + delete on same record | FR-MED-016, 017 | Terminal-state guard: delete on archived-with-history still requires zero dose records |

## 9. Data requirements

### 9.1 Owned data

| Entity | Lifecycle | Ownership | Notes |
|---|---|---|---|
| MedicineCatalogEntry (brandName, ingredientNames[], form, packagingQuantity, photoKeys{A,B,C}, createdAt, updatedAt) | create → community-edited forever → never deleted | shared community data — owned by no one, maintained by all | Duplicate-check on create (FR-MED-005); last-write-wins edits (FR-MED-006) |
| Catalog photo objects (R2 keys) | issued → uploaded → confirmed → replaced per slot | shared, referenced by catalog entry | Unguessable keys; public-read bucket (Map 3 t04) |
| PatientMedicine (patientId, catalogEntryId, prescribingDoctor, dosage, dosesRemaining, refillThreshold, price, pharmacyName, archived flag, createdAt) | adopt → edit/archive → hard-delete (zero dose records) or purge on `AccountDeleted` | owned solely per patient; never shared | Catalog fields resolved via catalogEntryId at read time |
| DoseOutcomeState (medicineId, doseId, lastOutcome) | insert on first event per dose → update per change → purge with medicine/account | owned solely | Enables idempotent delta (FR-MED-018/019) |
| Refill arm state (per medicine: lowStockArmed, outOfStockArmed) | derived, persisted | owned solely | FR-MED-023 |
| Outbox rows (`RefillThresholdCrossed`, `MedicineArchived`) | insert same-tx → publish → delete | owned solely (per-service outbox) | `@medo/eventing` pattern |

### 9.2 Consumed/read data

- Schedule & Dose `GET /v1/patients/{id}/has-dose-records` — provider: Schedule & Dose Service, contract: internal REST. Used only by the delete guard (FR-MED-017). No caching — must be synchronous and current; fail closed on unavailability.
- Care `GET /v1/care/check-link?patientId=&caregiverId=` — provider: Care Service, contract: internal REST. Used for caregiver authz on every patient-scoped call (FR-MED-026); consumer-side positive cache ~15 s per Map 3 t09 with `CareLinkEnded` invalidation.

### 9.3 Shared/community data

- **Medicine Catalog entries + catalog photos** — the platform's shared drug-identity layer. Any authenticated user may create (duplicate-checked) and edit (last-write-wins). Entries carry no owner; `AccountDeleted` never touches them (FR-MED-024). This is the catalog-split pattern approved in Map 2 ticket 07.

### 9.4 Retention & deletion

- Private Medicine records: account lifetime; archived records retained (history); hard delete only via FR-MED-017 guard.
- `AccountDeleted` consumption: purges the user's private records + dose-outcome tracking rows; catalog untouched (FR-MED-024). No timed purge job exists — Medicine has zero jobs (`scheduled-jobs.md`).
- Terminal/deleted private records leave no tombstone — dose history lives in Schedule & Dose and is governed by its own retention.
- Catalog entries and photos: retained indefinitely (community asset); no deletion path exists in v1.
- Orphan photo objects (unconfirmed keys): retention mechanism undecided — OQ-MED-03.
- No backups in v1 — accepted risk (`platform-quality-baseline.md`).

### 9.5 Sensitive data

- `prescribingDoctor`, `price`, `pharmacyName` on private records = health-adjacent PII; `patientId` linkage exposes medication existence.
- Catalog data (drug identities, photos) is non-personal shared content.
- Photo keys are unguessable locators on a public-read bucket — obscurity, not access control; no signed reads in v1 (Map 3 t04).
- No credentials, tokens, or secrets stored by this service.

## 10. External contracts touched

| Contract ID (verbatim) | Direction | Sync/Async | Public/Internal | Authz | Idempotent? | Catalog ref |
|---|---|---|---|---|---|---|
| `GET /v1/medicine-catalog?q=&page=` | exposes | REST | public | session | n-a | catalog §Medicine public REST — catalog |
| `GET /v1/medicine-catalog/{id}` | exposes | REST | public | session | n-a | catalog §Medicine public REST — catalog |
| `POST /v1/medicine-catalog` | exposes | REST | public | session | duplicate-check conflict (FR-MED-005) | catalog §Medicine public REST — catalog |
| `PATCH /v1/medicine-catalog/{id}` | exposes | REST | public | session | yes (last-write-wins) | catalog §Medicine public REST — catalog |
| `POST /v1/medicine-catalog/{id}/photos` | exposes | REST | public | session | n-a (key issuance) | catalog §Medicine public REST — catalog |
| `PUT /v1/medicine-catalog/{id}/photos/{slot}` | exposes | REST | public | session | yes (re-confirm replaces slot) | catalog §Medicine public REST — catalog |
| `GET /v1/medicines?patientId=` | exposes | REST | public | patient-self or linked caregiver | n-a | catalog §Medicine public REST — patient's medicines |
| `POST /v1/medicines` | exposes | REST | public | patient-self or linked caregiver | natural idempotency not guaranteed — client retry safe (creates distinct records; baseline rule) | catalog §Medicine public REST — patient's medicines |
| `GET /v1/medicines/{id}` | exposes | REST | public + internal | patient-self / linked caregiver / Medo service token | n-a | catalog §Medicine public + internal REST |
| `PATCH /v1/medicines/{id}` | exposes | REST | public | patient-self or linked caregiver | yes (last-write-wins) | catalog §Medicine public REST — patient's medicines |
| `POST /v1/medicines/{id}/archive` | exposes | REST | public | patient-self or linked caregiver | yes (FR-MED-016a) | catalog §Medicine public REST — patient's medicines |
| `DELETE /v1/medicines/{id}` | exposes | REST | public | patient-self or linked caregiver | yes (repeat → not-found/conflict, no partial state) | catalog §Medicine public REST — patient's medicines |
| `GET /v1/patients/{id}/has-dose-records` | consumes | REST | internal | Medo service token (`aud=medo-schedule-dose`) | n-a | catalog §Schedule & Dose internal REST |
| `GET /v1/care/check-link?patientId=&caregiverId=` | consumes | REST | internal | Medo service token (`aud=medo-care`) | n-a | catalog §Care internal REST |
| `RefillThresholdCrossed` | publishes | event | internal | n-a | envelope `{eventId, occurredAt}` | catalog §Event catalog |
| `MedicineArchived` | publishes | event | internal | n-a | envelope `{eventId, occurredAt}`; once per archive transition | catalog §Event catalog (added 2026-11-22) |
| `DoseOutcomeChanged` | consumes | event | internal | n-a | idempotent consumer (FR-MED-018/019) | catalog §Event catalog |
| `AccountDeleted` | consumes | event | internal | n-a | idempotent consumer (FR-MED-024b) | catalog §Event catalog |

### 10.1 Exposed contracts — detail

- Catalog routes: list/search (`q` text match + `page`), detail, create (duplicate-check), community PATCH, photo slot issue (`POST .../photos`) + confirm (`PUT .../photos/{slot}`). All sync REST under `/v1`; session auth only.
- Patient-medicine routes: list by `patientId`, adopt-create, detail, PATCH, archive, DELETE — all patient-scoped authz (FR-MED-026).
- `GET /v1/medicines/{id}` is dual-authz: public patient-scoped and internal Medo-service (FR-MED-025); the internal path serves service callers like Notification composing reminder text.
- Photo read URLs are embedded in catalog/medicine DTOs (R2 public-read, unguessable keys — Map 3 t04); no separate photo-read route exists.

### 10.2 Consumed contracts — detail

- `GET /v1/patients/{id}/has-dose-records` (Schedule & Dose): consumed synchronously inside DELETE only (FR-MED-017). Must be current — no cache. Timeout 3 s + 1 retry per baseline; any failure → fail closed (refuse delete). Provider unavailable does not block any other Medicine function.
- `GET /v1/care/check-link` (Care): consumed per patient-scoped request for caregiver sessions (FR-MED-026). Positive answers cached ~15 s consumer-side per Map 3 t09 (`CareLinkEnded` invalidates); negative answers never cached. Timeout 3 s + 1 retry; on failure → deny (authz fail-closed per baseline matrix).
- `DoseOutcomeChanged` (Schedule & Dose event): consumed for Doses Remaining deltas (FR-MED-019/020). Payload `{doseId, medicineId, patientId, outcome, actorId?, occurredAt}` + envelope; outcome ∈ `taken-on-time | taken-late | skipped | missed`. At-least-once → idempotent consumer mandatory.
- `AccountDeleted` (Identity event): purges private records only (FR-MED-024); at-least-once → idempotent.

### 10.3 Events published & subscribed

- Published: `RefillThresholdCrossed` — trigger: any `dosesRemaining` transition into ≤`refillThreshold` (first crossing or re-arm re-crossing) or into 0. Payload `{medicineId, patientId, dosesRemaining, threshold}` + `{eventId, occurredAt}` envelope; IDs + changed fields only per catalog conventions. `MedicineArchived` — trigger: archive transition (FR-MED-016); payload `{medicineId, patientId}` + envelope; consumed by Schedule & Dose to halt dose generation for the medicine's schedules. Ordering: events are independent; consumers must tolerate any order.
- Subscribed: `DoseOutcomeChanged` (required reaction: Doses Remaining delta + last-outcome update, FR-MED-019) and `AccountDeleted` (required reaction: private-record purge, FR-MED-024). Both consumers idempotent per baseline event rules; 5 attempts → `dead_letters` via `@medo/eventing`.
- No other service consumes Medicine events; no other Medicine subscriptions exist.

### 10.4 Authorization requirements

- Catalog routes (`/v1/medicine-catalog*`): any valid session — Patient or Caregiver; no `check-link` (shared community resource, FR-MED-027).
- Patient-scoped routes (`/v1/medicines*`): patient-self (`patientId`/owner = session `sub`) OR linked caregiver verified via Care `check-link` per request (FR-MED-026); caregiver gets full parity on medicines (Map 1 t03).
- Internal `GET /v1/medicines/{id}`: Medo service JWT only (`aud=medo-medicine`); user tokens rejected (FR-MED-025).
- Photo confirm (`PUT .../photos/{slot}`): session + key-ownership verification (key issued for this entry+slot, FR-MED-009) — the issued key is the capability.
- Acting-identity: dose-outcome deltas attribute implicitly via `actorId?` passthrough need — Medicine stores outcome state only; actor attribution lives in Schedule & Dose. `dosesRemaining` manual edits are patient-scoped-authz'd; no separate actor field required at requirement level.
- Frontend is never trusted: all authz server-side; catalog community-edit has no ownership check by design.

### 10.5 Versioning & compatibility

- All exposed REST contracts under `/v1`; catalog/medicine/photo IDs and `photoKey`s are opaque strings — format may evolve without contract change.
- Evolution rule: additive-only within `/v1`; breaking changes require a new version prefix + migration note per Architecture Standard.
- Known consumers constraining evolution: Notification (`RefillThresholdCrossed` payload — field removals break alert composition; `GET /v1/medicines/{id}` internal read for reminder text), Schedule & Dose (`has-dose-records` response shape is load-bearing for the fail-closed delete flow), frontend (all public routes), all services (`check-link` consumption is Medicine's dependency, not an exposure).
- Event schema evolution: additive-only unless versioned; `DoseOutcomeChanged`/`AccountDeleted`/`RefillThresholdCrossed` payloads may gain fields, never lose/rename without versioning.

## 11. Dependencies and integrations

### 11.1 Upstream dependencies

- Own Postgres `medicine_db` — catalog entries, private records, dose-outcome state, refill arm state, outbox. Failure → fail closed, 503 (baseline matrix).
- Schedule & Dose `GET /v1/patients/{id}/has-dose-records` — delete guard only; 3 s timeout + 1 retry; fail closed on failure (FR-MED-017).
- Care `GET /v1/care/check-link` — caregiver authz on patient-scoped routes; 3 s + 1 retry; fail closed (deny); ~15 s positive consumer cache per Map 3 t09.
- Cloudflare R2 bucket (public-read) — photo object storage; presigned PUT generation is local; attach-confirm verifies object existence (10 s, 2 retries, fail-closed per baseline R2 row).
- `broker_db` event transport via `@medo/eventing` — outbox publish + `DoseOutcomeChanged`/`AccountDeleted` consumption; built-in retry → `dead_letters` after 5 attempts.
- No Identity directory dependency — Medicine stores only `patientId`/`userId` references, never resolves profiles.
- No direct external providers: Medicine never calls Resend/web-push — Notification owns all delivery.

### 11.2 Downstream dependents

- Notification Service — `RefillThresholdCrossed` (refill push + feed; recipient mapping via Care) and internal `GET /v1/medicines/{id}` (reminder text composition).
- Schedule & Dose Service — `GET /v1/patients/{id}/has-dose-records` answers Medicine's delete guard; publishes `DoseOutcomeChanged` consumed here; consumes `MedicineArchived` to stop dose generation for archived medicines' schedules.
- Combined frontend — all 12 public Medicine routes via gateway (medicines list/detail/add/edit/archive/delete + catalog browse/search/photos).
- API gateway (Caddy/nginx) — pass-through proxy; public-route table must list Medicine routes (Map 3 t05).

### 11.3 Ordering constraints

- `POST /v1/medicines` requires an existing catalog entry — client must complete catalog create first when the drug is unknown (FR-MED-012); no server-side ordering beyond referential check.
- Photo confirm requires prior `POST .../photos` key issuance and completed direct-to-bucket PUT (FR-MED-007…009).
- `AccountDeleted` processing must complete private-record purge; catalog requires no action — event ordering vs in-flight `DoseOutcomeChanged` tolerated (late events no-op on missing records).
- Deploy order unconstrained: Medicine tolerates Schedule & Dose/Care/R2/broker outages via fail-closed errors and outbox retry; the delete guard is the only hard synchronous dependency.
- Consumers must treat `RefillThresholdCrossed` as at-least-once (idempotent delivery).

## 12. Success metrics

| Goal | Metric | Instrumentation | Guardrails |
|---|---|---|---|
| G-1 | Catalog search/browse p95; zero-result query rate | `/metrics` RED on catalog routes | p95 < 300 ms read class |
| G-2 | Catalog create success rate; duplicate-check conflict rate | counters on `POST /v1/medicine-catalog` | Zero duplicate entries created (invariant) |
| G-3 | Community-edit application rate; last-write-wins correctness | PATCH counters + audit log | Zero ownership-check rejections on catalog writes |
| G-4 | Medicine adopt success rate; adopt-with-unknown-catalogEntryId rejection rate | counters on `POST /v1/medicines` | Zero orphan private records (catalogEntryId always resolves) |
| G-5 | Photo flow completion rate (issue→upload→confirm); confirm rejection breakdown | counters on photo routes | Zero confirmed slots pointing at foreign/expired keys |
| G-6 | Doses Remaining drift: delta applications vs Schedule & Dose outcome count; floor-0 violations | consumer lag metrics + reconciliation counter | Zero negative counts; redelivery no-op rate = 100% |
| G-7 | Delete-guard correctness: deletes refused iff dose records exist or check unreachable | counters on DELETE + has-dose-records calls | Zero deletes with existing dose history (invariant) |
| G-8 | `AccountDeleted` purge completeness: private records removed, catalog untouched | consumer counter + post-purge read check | Zero surviving private records post-deletion |

## 13. Assumptions and constraints

- Locked decisions cited, not re-decided: catalog/private-record split + community-edit rules (Map 2 t07 amendment); Doses Remaining delta semantics + delete fail-closed rule (Map 2 t03); photo storage in-boundary + signed-URL flow (Map 2 t03a); refill threshold state ownership (Map 2 t03b); refill alert rules (Map 1 t08); authz parity (Map 1 t03); R2 public-read bucket + presigned PUT (Map 3 t04); rate limits + check-link cache (Map 3 t09); outbox eventing (Map 3 t07).
- Technical constraints already decided: Node.js + TypeScript + Fastify + Drizzle (Map 3 t01); self-hosted PostgreSQL one container/six logical DBs (Map 3 t03); Docker Compose on EC2, Vercel frontend (Map 3 t02); Cloudflare R2 S3-compatible (Map 3 t04).
- This PRD assumes the Architecture Standard's four-layer backend structure and one-combined-frontend topology; it does not re-decide them.
- Domain selection (`app.<domain>`/`api.<domain>`, R2 public base URL) remains map fog — non-blocking; photo URLs are env config (OQ-MED-05).
- Catalog duplicate-check normalization (case/whitespace) is specified at requirement level (FR-MED-005c); exact collation is LLD detail.

## 14. Glossary and terminology

Terms used → `GLOSSARY.md` anchors: **Patient**, **Caregiver**, **Medicine**, **Medicine Catalog**, **Doses Remaining**, **Refill alert**.

Avoid-list compliance: no "drug/medication/prescription" for Medicine in normative text ("medication" appears only inside quoted feature names); no "stock/inventory/quantity left" for Doses Remaining; no "reminder/alert/alarm" for Refill alert in normative text ("Refill alert" is the glossary term; "alert" alone avoided); no "database/dictionary/master list" for Medicine Catalog.

New technical terms (flagged `proposed-glossary-entry` for HLD/LLD clarity):

- **Catalog entry** — one shared Medicine Catalog row; the adopt target for private records.
- **Photo slot** — one of A (outer packaging) / B (inner pack) / C (naked dose); tags permanent per Map 1 t04.
- **Gap-fill** — read-time photo resolution falling back to the next-most-relevant stored slot (C→B→A, B→A).
- **Taken-class outcome** — `taken-on-time` or `taken-late`; the only outcomes that move Doses Remaining.
- **Refill arm state** — per-medicine persisted flags governing whether the `refillThreshold` and 0 threshold alerts may fire.
- **Photo key (`photoKey`)** — unguessable R2 object key issued per entry+slot; the confirm capability.

## 15. Traceability matrix

| Need (feature-list §) | Goal | Story | FR/NFR | Contract(s) | Verification |
|---|---|---|---|---|---|
| §3 caregiver parity authz | G-4, G-7 | US-MED-04, 05 | FR-MED-013, 015, 017, 026, NFR-MED-04 | patient-scoped medicine routes, `check-link` | contract + integration tests |
| §4 medicine model (catalog + private split) | G-1…G-5 | US-MED-01…04 | FR-MED-001…014, NFR-MED-01 | catalog + medicine routes | contract + integration tests |
| §4 photos A/B/C + gap-fill | G-3, G-5 | US-MED-01, 03 | FR-MED-002, 003, 007…010 | catalog detail + photo routes | unit + integration tests (R2 stubbed) |
| §4 edit/archive/delete rules | G-7 | US-MED-05 | FR-MED-006, 015…017, NFR-MED-05 | PATCH/archive/DELETE routes, `has-dose-records`, `MedicineArchived` | integration tests |
| §8 Doses Remaining + refill tracking | G-6, G-7 | US-MED-06, 07 | FR-MED-018…023, NFR-MED-06 | `DoseOutcomeChanged`, `RefillThresholdCrossed` | integration + contract tests |
| §8 refill recipients (patient + caregivers) | G-7 | US-MED-07 | FR-MED-022, NFR-MED-04 | `RefillThresholdCrossed` → Notification | contract test |
| Account-deletion safety (shared vs owned) | G-8 | US-MED-08 | FR-MED-024, 024b, NFR-MED-05 | `AccountDeleted` | integration tests |
| Platform NFRs | — | — | NFR-MED-01…06 | `/metrics`, `/health`, `/ready` | metric checks + smoke tests |

## Appendix A. Alternatives considered

- **Single per-patient medicine aggregate** — rejected Map 2 ticket 07 amendment: duplicated drug identities across patients; replaced by shared catalog + private record split.
- **Separate media/photo service** — rejected Map 2 ticket 03a: photo storage inside service boundary (R2 keys in DB); a dedicated media service is unjustified at this scale.
- **Push event to Schedule & Dose on archive** — rejected alternative considered during PRD review; resolved 2026-11-22 by user approval of the `MedicineArchived` event (Option A) over Schedule & Dose-side pull (Option B) and no-op (Option C). Catalog amended additively.
- **Event-driven delete check (async)** — rejected Map 2 ticket 03: delete requires synchronous `has-dose-records` answer, fail closed; async would race dose creation.
- **Signed-URL photo reads** — superseded by Map 3 t04: R2 public-read bucket + unguessable keys chosen over per-request signing (simpler; acceptable at hackathon scale).
- **Catalog ownership/moderation** — rejected Map 2 t07: community-editable last-write-wins; no owned entries means `AccountDeleted` never destroys shared data.

## Appendix B. HLD-readiness checklist result

- Result: **pass**
- Date: 22-11-26 04-52-28 UTC (approved same timestamp)
- Checker: Devin (self-check vs `prd-standard.md` §7 + `prd.schema.json`)
- Conditions: none — OQ-MED-01 resolved via `service-catalog.md` amendment (`MedicineArchived` event, user-approved 2026-11-22); OQ-MED-02/04 resolved by user decision; OQ-MED-03/05 non-blocking (HLD/env detail).
