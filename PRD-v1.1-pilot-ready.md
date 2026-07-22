# Product Requirements Document
## EU-Sovereign Investigation Platform — v1.1 (Pilot-Ready)

| | |
|---|---|
| **Document owner** | [you] |
| **Status** | Draft for planning |
| **Date** | 21 July 2026 |
| **Supersedes** | Nothing — first PRD; complements the Build Prompt (engineering rules), Strategy (market), Blueprint (v1 screen scope) |
| **Scope of this document** | Getting from *built v1* to *first paid design-partner pilot*. Not a from-scratch spec. |

---

## 1. Product summary

An EU-owned, EU-hosted investigation and case-management platform for financial-crime and compliance teams. It replaces the spreadsheet-plus-screenshots workflow analysts currently use to investigate AML alerts, and produces an auditor-defensible record of who saw what, why, and what they concluded.

**One-line positioning:** the European investigation platform for regulated teams.

**Primary buyer:** AML/compliance or fraud-investigation lead at an EU bank, payment institution, crypto-asset service provider, or insurer (50–500 employees; 5–20 analysts).

**Primary user:** the investigating analyst. Secondary users: supervisor (review/approve), compliance officer (audit), admin (users/ontology/intake).

---

## 2. Problem statement

An AML analyst receiving an alert today typically: pulls data from 3–5 systems by hand, assembles relationships in a spreadsheet or on paper, loses the reasoning trail between sessions, and reconstructs justification from memory when an auditor or regulator asks months later. Existing options are (a) Palantir-class platforms, priced and sold for governments and the Fortune 500, and increasingly politically difficult in Europe, or (b) point tools that visualize graphs but don't carry provenance, classification, or an audit trail — meaning the compliance evidence problem stays unsolved.

**What we're betting on:** that governance depth (provenance, property-level classification, tamper-evident audit, purpose-of-use) plus EU sovereignty is a defensible position that neither incumbent nor point tools currently occupy for the commercial mid-market.

---

## 3. Current state (as built, Phases 0–6)

Delivered and self-reviewed. Not yet pilot-ready — see §4.

| Area | Status |
|---|---|
| Ontology (object types as data, per-property provenance, typed edges) | Built |
| RLS enforced at DB via dedicated `app_user` role, proven by result-diff test | Built |
| Hash-chained append-only audit log + SQL-side verification | Built |
| Keycloak auth; AuthN (Keycloak) and AuthZ (`app_users`) deliberately split | Built |
| S1 case queue, S3 search, S4 entity detail | Built |
| S2 case workspace (3-pane, Cytoscape graph, linked selection + integration test) | Built |
| S5 CSV intake w/ mapping templates, quarantine; S6 resolution review queue | Built |
| S7 admin, audit viewer, case export (HTML print + Markdown), evidence snapshot | Built |
| Hardening: rate limits, helmet, CORS allowlist, configurable secrets, clean `npm audit` | Built |
| Deployment to an EU host | **Not started** |
| Verified performance at target scale | **Not started** |
| CI automation | **Not started** |

---

## 4. Release goal: v1.1 "Pilot-Ready"

**Definition of done:** a design partner's analysts use this on their own data, in a hosted EU environment, for a full alert-to-case cycle, and their security reviewer and compliance officer both sign off.

### 4.1 Blocking requirements (must ship)

| ID | Requirement | Rationale | Acceptance test |
|---|---|---|---|
| **B1** | Resolution-queue merge must fail loudly when RLS blocks the write | Currently the UPDATE can affect 0 rows while the queue row is marked merged and the audit log records success — the audit trail asserts something that didn't happen | Under-cleared user attempts merge on a RESTRICTED pair → operation errors, queue row unchanged, no false audit entry |
| **B2** | `resolution_queue` RLS inherits candidate-object classification | An analyst can currently see and act on pairs referencing objects above their clearance | Low-clearance session lists queue → pairs referencing RESTRICTED objects absent |
| **B3** | Breadth guard on `/graph/expand` recursive CTE | Hub entities (shared address/phone across thousands of accounts) are the normal shape of fraud data; depth-only capping can materialize a huge intermediate before LIMIT applies | Expansion from a 5,000-neighbor hub node at hops=3 returns within latency budget, no memory spike |
| **B4** | Verified performance at ≥1M objects / 5M edges: search <1s, 2-hop expansion <3s | Explicit acceptance criterion; current evidence is synthetic-seed-scale only | Load-test script + published results; `EXPLAIN ANALYZE` on search and expansion paths |
| **B5** | Trigram/index strategy fixed for actual query shapes | `similarity()` in ORDER BY can't use the GIN index; index exists only for `name`, but templates match on other properties | Query plans show index use for ingestion match + search on at least 2 non-`name` properties |
| **B6** | Ingestion moved off the synchronous request cycle (job queue + status polling) | A real partner CSV holds one HTTP request and one pooled connection for its full duration; pool is 10 | 50k-row upload returns 202 immediately, completes in background, status observable, no connection starvation |
| **B7** | Deployed to an EU host with backups + verified restore | The sovereignty claim is the product; an undeployed platform can't be piloted | Running instance on EU infrastructure; documented restore drill executed once |
| **B8** | CI: migrations, typecheck, lint, RLS test, audit-chain test, Vitest on every commit | Six phases of regression suites currently run by hand | Green pipeline; a deliberately-broken RLS policy fails the build |

### 4.2 Non-blocking but scheduled (v1.1 if capacity, else v1.2)

| ID | Requirement | Rationale |
|---|---|---|
| N1 | Purpose-of-use required (not defaulted) on admin role/clearance changes | Consistency with every other sensitive path; granting clearance is at least as sensitive as reading |
| N2 | Admin audit entries capture before/after values | "Who could see what, and when did that change" currently needs manual cross-referencing |
| N3 | Closed-case editability decided and enforced | Frozen report vs. still-editable live case will confuse an auditor |
| N4 | Retention enforcement (per-source `retention_days` is stored but not applied) | GDPR posture is a selling point; storing the policy without enforcing it is worse than not claiming it |
| N5 | Frontend/backend type drift closed (generated types or Zod at the boundary) | Silent `undefined` at runtime instead of a build failure |
| N6 | XLSX ingestion (blueprint said CSV/XLSX; only CSV shipped) | Partners will export XLSX; disclosed scope cut, not forgotten |

### 4.3 Explicitly out of scope for v1.1

Map view, timeline view, AI assistant layer, live system connectors, multi-tenant shared infrastructure, mobile, SSO federation to partner IdPs, community detection. These are v2, pulled by paying-customer demand — not built speculatively.

---

## 5. Pilot readiness (parallel track, not engineering)

These gate revenue as hard as the code does.

| ID | Item | Owner | Notes |
|---|---|---|---|
| P1 | 3–5 design partners recruited, paid pilots (€10–25k/yr) | You | Start now; don't wait for B1–B8 |
| P2 | DPA + DPIA template pack | Legal (~€15–30k with P3) | Reused in every enterprise deal |
| P3 | AI Act classification opinion for the fin-crime deployment context | Legal | High-risk obligations deferred to Dec 2027 — build conformity now, sell it as a feature |
| P4 | ISO 27001 gap assessment booked | You | €3–5k; tells you the real certification budget |
| P5 | Acceptable-use policy published | You | Differentiator in the post-Palantir-backlash EU market, not just ethics |
| P6 | Boutique penetration test before first partner data | You | €5–8k; not a Big-4 audit yet |
| P7 | Subprocessor list + data-residency statement | You | First thing a bank's third-party-risk team asks for under DORA |

---

## 6. Success metrics

**Product (measured during pilot):**
- Analyst completes alert→case→document→close without leaving the product or asking for help: yes/no per partner
- Investigation time per case vs. their baseline: target −40%
- Case export accepted by their audit/SAR process without rework: yes/no
- "Who accessed this customer and why" answered in <1 minute: measured live with their compliance officer

**Business:**
- 3+ paying design partners by end of pilot phase
- ≥1 written case study
- Security review passed at ≥1 partner without a blocking finding

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Real partner data behaves nothing like synthetic seed data (messier, dirtier, different shapes) | High — entity resolution thresholds (0.92/0.55) are untuned placeholders | Tune against a partner's real extract early in pilot; treat current thresholds as provisional |
| Scale testing reveals architectural problems, not just index problems | High — could reset the timeline | Do B4 early, not last; it's the finding most likely to change the plan |
| Partner recruitment lags engineering | High — product arrives with nobody waiting | P1 starts now, in parallel |
| Solo-builder bus factor | High | Document as you go (already strong); consider technical co-founder before fundraising |
| Sovereignty premium erodes as US vendors ship EU-cloud wrappers | Medium (2027+) | Moat is governance depth, not hosting geography — keep that the emphasis |
| Certification cost/time underestimated | Medium | P4 gap assessment before committing to a date |

---

## 8. Sequencing recommendation

1. **Now, parallel:** P1 (partners) + B4 (scale test — it's the highest-information task and could change everything downstream)
2. **Then:** B1, B2, B3, B5 (correctness/security fixes — small, well-understood)
3. **Then:** B6 (ingestion job queue — the one real architectural change)
4. **Then:** B7, B8 (deploy + CI)
5. **Throughout:** P2–P7 on legal/compliance's timeline, which is slower than yours

---

## 9. Open questions

1. Which specific fin-crime workflow do the first partners actually run — alert triage, sanctions-network mapping, or internal fraud? Current v1 assumes alert-to-case; confirm before tuning further.
2. Do partners need on-prem, or is EU-hosted cloud acceptable? Changes deployment scope significantly.
3. Is "closed" a hard freeze or an administrative state? (N3)
4. What's the realistic ceiling on partner data volume — does B4's 1M/5M target match reality, or is it 10x off in either direction?
