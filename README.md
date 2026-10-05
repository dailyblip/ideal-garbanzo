# Launch Your Data Center Career

Temporary repository name. This project is the entry-level data center careers job board.

## Locked product direction

The approved visual mockup is the design target. Do not redesign or reinterpret the homepage without explicit approval.

Core audience: people seeking entry-level data center jobs, internships, apprenticeships, trainee roles, and opportunities requiring limited prior experience.

## Build phases

1. Visual shell matching approved mockup.
2. Normalized jobs schema and demo data.
3. Automated discovery, classification, deduplication, and stale-listing removal.
4. Employer posting and paid promotion flow.
5. Deployment, monitoring, SEO, and QA.

## Employer-direct sourcing

Priority operators are collected from their official career systems. The main daily scan is supplemented by a conservative targeted Workday recovery pass for Vantage, QTS, CyrusOne, STACK, NTT Global Data Centers, and Aligned so mission-fit 0–5 year roles that are temporarily omitted from broad listings can still be discovered and detail-verified. The recovery pass is additive only and fails closed on unknown experience requirements.

Source ownership matters: Vantage, QTS, CyrusOne, STACK, NTT Global Data Centers, and Aligned are owned by the reconciled major Workday pipeline (`collect-major-jobs.mjs` plus targeted recovery). Do not add a second dedicated feed writer for one of these employers without first transferring that employer out of the major Workday snapshot and updating the parity guard. This prevents competing collectors from replacing each other's verified requisitions or breaking deployment parity.

## Promotion model

- Standard employer posting
- Boosted listing
- Featured homepage placement

Promoted listings must remain clearly labeled and relevant to the site's early-career audience.

## Publication recovery checks

The full refresh must run every authoritative source collector before aggregate
freshness validation. Source-owned verification timestamps must come from the
successful source check, never a later global status update. Google uses its
freshness wrapper; AWS and Oracle stamp evidence immediately after collection.
Existing 96-hour fallback limits remain enforced before publication.

Live QA removes only positively confirmed closed job URLs. The reconciliation
step applies those same closures to the owning snapshots and inventory counters
without renewing source-health timestamps. Nightly QA stages the reconciler's
`--list-paths` manifest atomically and rebuilds from latest main on a write race.

Focused offline regression checks:

```sh
node scripts/validate-full-refresh-contract.mjs
node scripts/test-google-collector-freshness.mjs
node scripts/stamp-oracle-source-freshness.mjs --test
node scripts/reconcile-qa-dead-snapshots.mjs --test
```

A successful dispatch is not successful publication. Verify the completed Pages
run, the exact SHA in `https://datacentercareers.us/deployment-version.json`, and
that the live `data/jobs.json` matches the deployed artifact before reporting a
refresh complete. Aggregate validation and live-feed checks remain mandatory.
