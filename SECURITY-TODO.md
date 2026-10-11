# Security — Code Scanning Backlog

Open GitHub code-scanning alerts to triage and resolve in a dedicated security
iteration. Snapshot taken **2026-10-12**. Source of truth is the live list:
<https://github.com/scormflow/scorm-engine/security/code-scanning?query=is%3Aopen>

**19 open** = 13 CodeQL (code) + 6 OpenSSF Scorecard (repo hygiene).

> Fetch the current list any time with:
> `gh api repos/scormflow/scorm-engine/code-scanning/alerts -f state=open -f per_page=100 --jq '.[]|[.number,(.rule.security_severity_level//.rule.severity),.rule.id,(.most_recent_instance.location.path+":"+(.most_recent_instance.location.start_line|tostring))]|@tsv'`

---

## CodeQL — code findings (13)

Each links to the alert (`…/security/code-scanning/<#>`).

### High

- [ ] **#30 · `js/insufficient-password-hash`** — [src/auth/api-key.ts:16](src/auth/api-key.ts#L16)
  API keys hashed with plain SHA-256. *Triage:* keys are high-entropy random, so this is lower risk than a user password, but consider HMAC-SHA256 with a server secret (peppered) or a slow KDF. ([#30](https://github.com/scormflow/scorm-engine/security/code-scanning/30))
- [ ] **#31 · `js/reflected-xss`** — [src/http/routes/embed.ts:113](src/http/routes/embed.ts#L113)
  Player page reflects request-derived data into HTML. *Fix:* strictly validate/encode `contentUrl`, `theme`, and any reflected input; the content URL is already attribute-escaped — verify all sinks. ([#31](https://github.com/scormflow/scorm-engine/security/code-scanning/31))
- [ ] **#32 · `js/missing-rate-limiting`** — [src/http/routes/content.ts:28](src/http/routes/content.ts#L28) ([#32](https://github.com/scormflow/scorm-engine/security/code-scanning/32))
- [ ] **#33 · `js/missing-rate-limiting`** — [src/http/routes/embed.ts:72](src/http/routes/embed.ts#L72) ([#33](https://github.com/scormflow/scorm-engine/security/code-scanning/33))
- [ ] **#37 · `js/missing-rate-limiting`** — [src/http/routes/cmi5.ts:245](src/http/routes/cmi5.ts#L245) ([#37](https://github.com/scormflow/scorm-engine/security/code-scanning/37))
- [ ] **#38 · `js/missing-rate-limiting`** — [src/http/routes/cmi5.ts:266](src/http/routes/cmi5.ts#L266) ([#38](https://github.com/scormflow/scorm-engine/security/code-scanning/38))
  *Fix (32/33/37/38):* apply the existing `rate-limit` plugin to these routes (static content, player page, cmi5 endpoints).
- [ ] **#35 · `js/polynomial-redos`** — [src/storage/scoped.ts:46](src/storage/scoped.ts#L46) ([#35](https://github.com/scormflow/scorm-engine/security/code-scanning/35))
- [ ] **#36 · `js/polynomial-redos`** — [src/storage/s3.ts:347](src/storage/s3.ts#L347) ([#36](https://github.com/scormflow/scorm-engine/security/code-scanning/36))
  *Fix (35/36):* replace the backtracking-prone regex on uncontrolled input with a linear parser or anchored/bounded pattern.
- [ ] **#39 · `js/weak-cryptographic-algorithm`** — [src/xapi/documents.ts:34](src/xapi/documents.ts#L34) ([#39](https://github.com/scormflow/scorm-engine/security/code-scanning/39))
- [ ] **#40 · `js/weak-cryptographic-algorithm`** — [src/xapi/ifi.ts:27](src/xapi/ifi.ts#L27)
  *Triage:* xAPI `mbox_sha1sum` is **spec-mandated SHA-1**. Likely **dismiss as "used in tests"/"won't fix"** with a justification rather than change — confirm the sink before deciding. ([#40](https://github.com/scormflow/scorm-engine/security/code-scanning/40))
- [ ] **#41 · `js/remote-property-injection`** — [src/tracking/attempts.ts:528](src/tracking/attempts.ts#L528) ([#41](https://github.com/scormflow/scorm-engine/security/code-scanning/41))
- [ ] **#42 · `js/remote-property-injection`** — [src/xapi/multipart.ts:71](src/xapi/multipart.ts#L71) ([#42](https://github.com/scormflow/scorm-engine/security/code-scanning/42))
  *Fix (41/42):* validate/allow-list dynamic property keys before assigning into objects (guard against `__proto__`/`constructor`).

### Note

- [ ] **#43 · `js/unused-local-variable`** — [src/http/routes/xapi.ts:80](src/http/routes/xapi.ts#L80) — trivial cleanup. ([#43](https://github.com/scormflow/scorm-engine/security/code-scanning/43))

---

## OpenSSF Scorecard — repo hygiene (6)

These are repository/process findings, not code bugs — resolved via settings & policy, not patches.

- [ ] **#1 · Branch-Protection** (high) — enable branch protection on `main` (require PR + review + status checks). ([#1](https://github.com/scormflow/scorm-engine/security/code-scanning/1))
- [ ] **#24 · Code-Review** (high) — enforce review before merge (direct pushes to `main` reduce this score). ([#24](https://github.com/scormflow/scorm-engine/security/code-scanning/24))
- [ ] **#28 · Vulnerabilities** (high) — resolve known-vulnerable dependencies flagged by Scorecard/OSV. ([#28](https://github.com/scormflow/scorm-engine/security/code-scanning/28))
- [ ] **#25 · Fuzzing** (medium) — add a fuzz target (e.g. for the manifest/zip parser). ([#25](https://github.com/scormflow/scorm-engine/security/code-scanning/25))
- [ ] **#27 · Security-Policy** (medium) — ensure `SECURITY.md` is detected (present in repo — verify location/format). ([#27](https://github.com/scormflow/scorm-engine/security/code-scanning/27))
- [ ] **#23 · CII-Best-Practices** (low) — pursue an OpenSSF Best Practices badge. ([#23](https://github.com/scormflow/scorm-engine/security/code-scanning/23))

---

## Suggested order for next iteration

1. **Quick wins:** #43 (unused var), rate limiting #32/#33/#37/#38 (reuse existing plugin).
2. **Real fixes:** ReDoS #35/#36, property injection #41/#42, reflected-XSS #31.
3. **Triage/justify:** weak-crypto #39/#40 (xAPI SHA-1 is spec-mandated — likely dismiss with reason), password-hash #30.
4. **Repo hygiene (Scorecard):** branch protection + required review on `main` (#1/#24), then #28/#25/#27/#23.

> Related: `scorm-engine-client` has **3** open alerts — track separately if pursued.
