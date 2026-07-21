# Security gap assessment (ISO/IEC 27001:2022 Annex A)

Informal, code-level gap assessment against ISO 27001:2022's Annex A control set — the "cheap,
fast" pass the strategy document calls for before booking real certification budget. **This is
not a certification audit and does not replace one.** A qualified external auditor or ISO 27001
lead implementer still needs to run the real gap assessment before any certification attempt;
this document exists so that conversation starts from an honest baseline instead of a guess.

Scope: the codebase and architecture built in this repository (Phases 0–5). Organizational,
People, and Physical controls (Annex A themes 5.1–5.37 non-technical items, all of A.6, all of
A.7) are mostly **not assessable from code** — they depend on company policy documents, HR
processes, office/datacenter arrangements, and vendor contracts that don't exist yet at this
stage of the company. Those are marked "organizational — out of scope for this document" below,
not silently skipped.

Status legend: **Covered** (real, verified control exists) · **Partial** (some control exists,
real gap remains) · **Gap** (no control yet) · **N/A** (not applicable at this stage).

## A.5 Organizational controls (selected, code-relevant items only)

| Control | Status | Evidence / gap |
|---|---|---|
| A.5.1 Policies for information security | Gap | No standalone written InfoSec policy document. The build prompt and phase reviews function as informal architecture policy but were never formally adopted as company policy. |
| A.5.9 Inventory of information assets | Partial | `object_types` is a live data-asset inventory for *ontology* data. No inventory of infrastructure assets (containers, secrets, third-party services). |
| A.5.12 Classification of information | **Covered** | Four-tier classification (`PUBLIC`/`INTERNAL`/`SENSITIVE`/`RESTRICTED`) is a first-class column on every classified table, enforced by RLS — not a label applied after the fact. See `PHASE0_REVIEW.md`. |
| A.5.15 Access control | **Covered** | RBAC (role) + ABAC (clearance) via Postgres RLS, verified with real low/high-clearance session diffs, not policy inspection. See `db/scripts/test-rls.sh`. |
| A.5.16 Identity management | **Covered** | Keycloak (OIDC). AuthN/AuthZ deliberately separated — see `PHASE1_REVIEW.md`. |
| A.5.17 Authentication information | Partial | Browser flow uses real Authorization Code + PKCE (`PHASE2_REVIEW.md`). Backend test scripts still use password-grant (ROPC) against the same client — flagged as needing a separate client config before any real deployment. |
| A.5.18 Access rights | **Covered** | Provisioning/deprovisioning via `/admin/users`, takes effect on the user's next request (no cached authorization in the token) — verified live in `PHASE5_REVIEW.md`. |
| A.5.23 Information security for cloud services | Gap | Nothing is cloud-hosted yet; this entire stack runs in local Docker. No cloud provider security review has happened because there's no cloud deployment to review. |
| A.5.28 Collection of evidence | **Covered** | Hash-chained, append-only audit log with a verified tamper-detection mechanism (`PHASE0_REVIEW.md`) and a proven fix for a real concurrency bug that could have forked the chain (`PHASE3_REVIEW.md`). |
| A.5.31 Legal, statutory, regulatory requirements | Gap | No DPIA template, no records-of-processing export, no AI Act conformity documentation yet — all named as near-term work in the strategy document, none built this session. |
| A.5.34 Privacy of PII | Partial | Classification + RLS limit exposure by clearance. No data-subject-request tooling (export/delete a specific person's data on request), no formal DPIA process. |

## A.6 People controls — organizational, out of scope for this document

Background verification, terms of employment, security awareness training, disciplinary
process, remote working policy. None of these exist yet because the company doesn't have
employees beyond (presumably) its founder at this stage. Revisit at first hire.

## A.7 Physical controls — organizational, out of scope for this document

Physical entry, equipment security, clear desk/screen. N/A while the stack runs on a local
development machine with no office or datacenter footprint yet.

## A.8 Technological controls

| Control | Status | Evidence / gap |
|---|---|---|
| A.8.2 Privileged access rights | **Covered** | Admin-only actions (user management, schema/source/template creation) gated at both the route and the database (RLS), not just app-level checks — a routing bug can't grant privilege past RLS. |
| A.8.3 Information access restriction | **Covered** | RLS on every classified table, `FORCE ROW LEVEL SECURITY`, proven not to be bypassable by the app's connection role. The one documented exception (redaction inside `evidence_snapshot` jsonb, which RLS can't reach) is handled by explicit application-level filtering — see `PHASE5_REVIEW.md`. |
| A.8.5 Secure authentication | Partial | OIDC + PKCE for the real browser flow. The Keycloak client still has `directAccessGrantsEnabled: true` for backend test scripts (ROPC) — needs splitting into a browser-only client and a separate CI/test client before this is production-appropriate (named in `PHASE2_REVIEW.md`). |
| A.8.9 Configuration management | Partial | Infrastructure config (docker-compose, migrations) is version-controlled. No formal configuration baseline, no drift detection, no infrastructure-as-code beyond docker-compose. |
| A.8.10 Information deletion | Gap | `ingestion_sources.retention_days` is stored and configurable but **not enforced** — nothing purges data after that many days. Named explicitly in `PHASE4_REVIEW.md`. |
| A.8.12 Data leakage prevention | Partial | RLS prevents cross-clearance leakage by construction. No DLP tooling for bulk-export monitoring, no anomaly detection on unusual access volume — the audit log records everything but nothing currently *alerts* on it. |
| A.8.15 Logging | **Covered** | Every read, write, search, export, and admin action logs through one hash-chained table (`write_audit_log()`), with required purpose-of-use. Verified: real tamper detection, real concurrency-safety fix, meta-audit (viewing the log is itself logged). |
| A.8.16 Monitoring activities | Gap | No SIEM integration, no alerting on suspicious patterns (e.g., one user reading unusually many `RESTRICTED` records in an hour). The audit log is queryable after the fact, not monitored in real time. |
| A.8.20 Network security | Gap | No network segmentation, no WAF, no TLS termination configured — everything runs over plain HTTP on localhost. All of this is deployment-environment concerns that don't exist yet because there's no deployment. |
| A.8.24 Use of cryptography | Partial | Standard OIDC/JWT crypto via Keycloak; SHA-256 for the audit hash chain; Postgres/bcrypt-class password hashing inside Keycloak. No application-level encryption at rest for the database beyond whatever the underlying disk/volume provides — that's an infrastructure decision for the eventual EU host, not something this codebase controls. |
| A.8.25 Secure development lifecycle | Partial | This entire six-phase build followed a consistent build→verify→self-review→commit pattern with real tests at each step (not just typechecks) — informal but real SDLC discipline. No formal SDLC policy document, no independent code review (single-agent-built), no SAST/DAST tooling beyond `npm audit`. |
| A.8.26 Application security requirements | **Covered** (for what's built) | Access control, audit, and classification requirements were treated as P0 from Phase 0 — "access control before ingestion" was a deliberate sequencing choice, not an afterthought. |
| A.8.28 Secure coding | Partial | Parameterized queries throughout (no raw string interpolation of user input into SQL found in review); RLS session variables set via `set_config()`, never string-interpolated. Input validation is deliberately minimal (`objectValidation.ts` — required-field + type checks only, no format/pattern validation) — named in `PHASE4_REVIEW.md`. |
| A.8.29 Security testing in development | Partial | Real, repeatable security tests exist (`test-rls.sh`, `test-audit-chain.sh`, `test-rls-http.sh`) and were re-run after every phase's changes. None of them run in CI yet — they're manual/local only. |
| A.8.31 Separation of environments | Gap | One local dev environment only. No staging, no production, no environment-specific config beyond `.env`/env-var overrides. |
| A.8.32 Change management | Gap | Git history is a de facto change record (every phase is a reviewed, documented commit), but there's no formal change-approval process, no CAB, no deployment pipeline gate. Reasonable for a pre-pilot solo build; not sufficient once a design partner's real data is involved. |

## Prioritized gaps (rough effort, before a design-partner pilot)

1. **Split the Keycloak client** (browser-only PKCE client vs. a separate CI/test ROPC client) — small, should happen before any shared environment exists. (A.5.17, A.8.5)
2. **Enforce `retention_days`** with a scheduled deletion job — medium; currently the policy is configurable but cosmetic. (A.8.10)
3. **Stand up CI running the existing test suites** (RLS, audit chain, HTTP RLS, Vitest, both typechecks, `npm audit`) on every push — small; the tests already exist, they just aren't automated yet. (A.8.29, A.8.32)
4. **DPIA template + records-of-processing export** — medium, needed before any real personal data flows through the system per the strategy document's own phasing. (A.5.31, A.5.34)
5. **Real secrets management for any shared environment** — the mechanism now exists (this session's hardening work: configurable passwords via `.env`, never hardcoded-only) but still needs an actual secrets store (cloud KMS/Vault) once there's a real shared or production environment to protect. (A.8.24)
6. **Basic monitoring/alerting on the audit log** (e.g., alert on unusual `RESTRICTED`-classification read volume per user per hour) — medium, turns the audit log from forensic-only into detective. (A.8.16)

## What this assessment deliberately does not claim

It does not claim ISO 27001 readiness, does not substitute for a lead auditor's gap assessment,
and does not cover the Organizational/People/Physical controls that depend on company policy
documents and processes that don't exist yet at this company's current stage. It's a snapshot
of what the *codebase* does and doesn't do, dated to this commit.
