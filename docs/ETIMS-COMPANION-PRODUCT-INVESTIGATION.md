**Oraforge eTIMS Companion: investigation and developer product proposal**

Reviewed: 21 October 2026. This is an investigation and proposed design, not an implementation or certification statement.

**Recommendation**

Build a developer integration product around a versioned API, reliable recovery, merchant isolation, inventory reconciliation and support. Retain the companion as the local execution agent, and introduce an adapter for the documented OSCU/VSCU integration route. Resolve the findings below before distributing production credentials or selling broad production access.

**Scope and evidence**

Reviewed the available C#, Python, Node and Vercel handler source and public KRA guidance. SHA-256 comparison confirmed that `capacitor/etims-supabase-worker.js` matches the deployed worker at `C:\Oraforge-eTIMS-Companion\etims-supabase-worker.js`. The C# source was reviewed; equivalence between that source and every deployed executable was not established. No binary decompilation or new performance benchmark was necessary for these source findings.

No cloud database connection, live invoice submission, device-file extraction, client execution, fiscal database modification, or firewall-rule change was performed. The only workspace change is this report. Existing firewall state and central KRA acceptance were not tested. Secrets are intentionally omitted.

**What already provides a useful foundation**

- The helper binds to loopback, checks its bearer token, and rejects browser Origin requests (`windows/etims-helper/server.py:51`, `:122`).
- Local jobs bind sale identity to an immutable payload digest and reject changed payloads (`windows/etims-helper/store.py:64`).
- A process mutex serializes companion operations (`windows/etims-helper/engine.py:108`). This does not establish that the official client uses the same mutex.
- The result already distinguishes local issuance from unverified KRA acceptance (`windows/etims-helper/engine.py:131`). Preserve and expose that distinction throughout the cloud UI.
- The existing local job ledger, item mapping, preflight and receipt pipeline can support a larger product without replacing the whole POS.

**Findings to resolve before broad commercial distribution**

| Finding | Observed evidence | Required outcome |
| --- | --- | --- |
| Cloud authorization is absent from the reviewed invoice handlers | `api/etims/jobs.js:7` accepts caller-controlled shop identity; `api/etims/jobs/[id].js:22` returns jobs by hash or numeric ID without a tenant predicate. No authorization verification appears in these handlers. External deployment protection was not audited. | Authenticate developers and merchants; derive tenant from verified credentials; authorize every read/write. CORS settings and a shop header are not authorization. |
| Workers claim work across shops | `capacitor/etims-supabase-worker.js:325` claims any pending job. Its configured shop is not a filter. | Bind enrollment and every claim to authorized tenant, seller PIN, branch and fiscal device. Require seller identity and compare it with the registered adapter. Local optional seller-PIN checks are not the cloud tenant boundary. |
| Order writeback can match another receipt | `capacitor/etims-supabase-worker.js:393` updates by order ID OR ticket number, without tenant/shop scope. | Use the immutable tenant-scoped order foreign key. Reject ambiguous matches and publish queue/order changes in one cloud transaction. |
| Privileged database credentials are embedded | The worker and `api/db.js` contain a literal fallback connection string. Both disable TLS certificate verification. A key-bearing JSON file is also present in the engine directory; its runtime use/distribution was not established. | Rotate the embedded database credential before redistribution; remove fallback secrets and exclude key-bearing artifacts from releases. Give installed agents narrowly scoped credentials or a scoped HTTPS API, with certificate verification. Never distribute a shared database owner credential. |
| Product information is automatically asserted as verified | Worker lines 230-241 supply one classification, fixed unit/origin defaults, fallback stock/cost and `verified: true`. C# lines 674-677 use generic defaults; line 787 assigns 1,000 opening units for missing items. | Require approved item classification, actual units, tax category and evidenced opening stock. Record who confirmed each value. Missing data must produce an actionable validation result. |
| Database commit and outbox publication have a crash gap | C# line 612 commits; line 615 writes outbox envelopes afterwards. `SaveEncryptedEnvelope` writes directly to the watched filename at line 1269. The Python issuance journal is written only after the generator returns (`fast_invoice.py:218`). | Persist submission intent before execution, recover an already-issued invoice without signing another, and track each dispatch artifact. Publish complete files atomically where the dispatcher contract permits. A file rename alone cannot make a database transaction and several files atomic. |
| Cloud jobs have no visible lease recovery | Worker marks `processing`, but has no lease expiry, owner token or reconciliation loop. Queue completion and order writeback are separate queries. | Add worker ownership, lease/fencing tokens, bounded retry/backoff and a review state for uncertain fiscal outcomes. Reconcile expired claims against local fiscal evidence before reissuing. |
| Cloud readiness does not establish actual readiness | `api/etims/preflight.js:14` always returns ready. Health can select another shop's heartbeat and does not require its stored helper health to be successful. | Run a tenant/device-specific preflight and publish separate agent, helper, registration, catalog and transmission states. |
| A diagnostic reports facts it never checks | `windows/etims-helper/offline.py:7` returns constant firewall/offline assertions. Earlier Windows documentation describes real checks and UI-only issuance that no longer match this source. | Remove unsupported diagnostic assertions and update documentation. Any future inspection must be read-only; this report proposes no firewall changes. |
| Fiscal calculations and envelopes need a wider validation matrix | Python validation permits global rates 0/16. C# uses `double`, calculates tax for B only, and emits zero C/E header totals in the outbox although its database accumulator recognizes C/E. Request tax codes can also update registered item tax categories. | Use explicit item tax mappings, decimal arithmetic and specified rounding. Reject unsupported categories before issuance; compare all line/header totals across POS, local invoice and submitted payload. Separate catalog changes from checkout. |
| Stock updates need aggregation by item | Each C# line resolves stock before later stock updates, then writes its own residual; repeated lines for one item can overwrite rather than accumulate deductions. Residuals are clamped to zero at line 848. | Aggregate sold quantities per registered item; distinguish stock shortages from legitimate adjustments; test repeated lines, fractional quantities and returns. |
| Artifact provenance is misleading | C# line 634 assigns a QR hash to `PdfSha256`; the bridge carries it as an original PDF hash. | Keep separate hashes and provenance for generated QR, generated receipt and any actually captured official PDF. Never label a QR hash as a PDF hash. |

The cloud handler performs lookup-then-insert for duplicate prevention. A deployed database unique constraint was not inspected, so concurrent duplicate prevention there remains unverified. Add a tenant-scoped unique idempotency key and immutable payload digest, rather than relying on an application lookup alone.

The engine reads the security packet length at offset 6,100 and its payload at 6,200 in this source, not approximately 61 million. These are observed implementation details, not a stable public API contract. Package portability does not mean fiscal identity can be copied between businesses or machines.

**How far to extend the integration**

KRA documents system-to-system integration through VSCU and OSCU APIs, with development, testing, vetting and certification. VSCU targets bulk/intermittent connectivity; OSCU targets continuously online invoicing. The reviewed public documentation did not establish direct Paypoint database insertion or extracted-key signing as a supported public integration contract. This is a bounded documentation finding, not a legal conclusion. [KRA integration guidance](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/etims-system-to-system-integration)

The certification portal lists business/TCC documents, architecture documentation, at least three qualified technical staff, sandbox testing and reviews. A functioning local signature is not evidence that the product is certified. Certification should be checked for the relevant product/version and solution scope. [KRA certification process](https://etims.kra.go.ke/main/signup/indexLearnMore), [approved integrators dated 26 January 2026](https://www.kra.go.ke/images/publications/List-of-Approved-eTIMS-3rd-party-integrators-as-at-26th-January-2026.pdf)

Use an internal adapter interface such as `capabilities`, `identity`, `preflight`, `submitSale`, `lookupSale`, `submitCreditNote`, `syncCatalog`, `syncPurchases` and `transmissionEvidence`. Report unsupported operations explicitly. Keep the public developer API independent of Paypoint table names, encryption details and filesystem offsets. Do not automatically switch adapters and resubmit when the first adapter's outcome is uncertain.

The April 2023 specifications still linked from KRA describe purchases, imports, customer/branch information, items and composition/BOM, stock in/out/master and sales/returns. These provide roadmap candidates; they do not prove that the installed Paypoint build offers the same supported interfaces. The VSCU document describes a local JAR and a 24-hour connectivity restriction on receipt-number issuance; do not generalize that restriction to Paypoint or promise unlimited offline fiscal signing. Confirm current behavior during integration testing. [OSCU v2.0](https://www.kra.go.ke/images/publications/OSCU_Specification_Document_v2.0.pdf), [VSCU v2.0](https://www.kra.go.ke/images/publications/VSCU_Specification_Document_v2.0.pdf)

**Features worth building, in order**

| Priority | Feature | Companion integration and value |
| --- | --- | --- |
| 1 | Recovery and reconciliation dashboard | Show POS sale, local fiscal reference, outbox publication, transmission evidence, rejection reason and next action. Link every stage to one immutable sale. Resolve uncertain jobs before resubmission. |
| 1 | Merchant and device enrollment | Pair an installed agent with approved tenant/PIN/branch/device using a one-use enrollment code. Display detected business for merchant confirmation. Protect companion credentials locally and redact support bundles. |
| 1 | Catalog and tax mapping manager | Map stable POS SKU to registered fiscal item; approve classifications, units and tax treatment; import master data with conflict review. Use validated reference data instead of universal defaults. |
| 2 | Developer SDK and deterministic simulator | Ship OpenAPI, TypeScript and PHP/Laravel examples first, plus mock success, duplicate, rejection, outage and uncertain-result cases. Simulated receipts must be visibly non-fiscal. |
| 2 | Credit notes and partial returns | Retain original invoice/solution/branch/device references; cap cumulative returned quantities and values; require reason/approval; separate refund payment from fiscal credit note and stock return. |
| 2 | Inventory and purchase reconciliation | Compare POS and fiscal stock; confirm actual opening inventory; support purchases, receiving, transfers, returns, damage/disposal and reasoned adjustments. Extend imports/BOM only after validating their adapter capabilities. |
| 2 | Signed events and developer support console | Deliver authorized event callbacks with signature, event ID, retries and replay protection. Give developers per-merchant queue health and redacted diagnostics. Receiving callbacks does not require opening inbound access on merchant PCs. |
| 3 | Multi-branch/till coordination | Preserve independent fiscal device sequences and use one writer per registered device. Multiple tills can queue to the assigned writer; cross-business jobs cannot share identity. No cloning fiscal device state for failover. |
| 3 | Receipt services and accounting connectors | Reprint the same fiscal record, export accountant reconciliation data and add targeted ERP/ecommerce connectors. Optional customer delivery requires merchant configuration and introduces messaging costs. |
| 3 | Update and support tooling | Signed release manifests/installers, verified compatible client versions, rollback of companion binaries, sanitized diagnostics and maintenance windows. Preserve the fiscal ledger across upgrades. |

KRA's 7 September 2026 notice specifically covers accurate records of stock received/purchased, sold, transferred, returned, adjusted and disposed of. That makes inventory reconciliation a timely product direction; the notice does not by itself establish a new API deadline. [KRA stock-management notice](https://www.kra.go.ke/news-center/public-notices/2390-implementation-of-the-stock-management-functionality-for-electronic-invoicing)

KRA says credit notes must come from the solution that issued the original invoice. Preserve those routing references through migration; the reviewed guidance did not establish an additional universal same-physical-device rule. [KRA solution guidance](https://www.kra.go.ke/business/etims-electronic-tax-invoice-management-system/learn-about-etims/types-of-etims-solutions)

A signature/QR, disappearance of an outbox file, HTTP delivery success and central invoice acceptance are different evidence. Mark acceptance only when the chosen supported integration provides authoritative evidence, and state its scope. KRA identifies transmission failures as a cause of missing invoices in VAT returns. [KRA VAT-return guidance](https://www.kra.go.ke/helping-tax-payers/faqs/the-vat-auto-populated-return)

**Concrete API and job design**

Proposed public endpoints: `POST /v1/invoices`, `GET /v1/invoices/{id}`, `POST /v1/credit-notes`, `POST /v1/catalog/validate`, `GET /v1/devices/{id}/health`. Accept an idempotency key, validate the complete sale snapshot and return a durable job ID immediately. An authenticated merchant context determines the tenant; request headers cannot select an arbitrary business.

Track local issuance and central transmission separately. A locally issued invoice may have transmission states `pending`, `sent`, `acknowledged`, `rejected` or `unknown`. Keep `review_required` for an uncertain issuance outcome. Include timestamps, payload digest, fiscal references and the evidence behind each status. A repeated request with the same key and different payload must conflict; an identical request returns the existing job.

Cloud queue additions should include tenant, taxpayer, branch, assigned device, operation, payload digest, idempotency key, owner, lease expiry, attempt count, next attempt time and last error. Enforce uniqueness in the database. Scope reads, claims and writes to the authenticated tenant/device. Use a restricted database role or an authenticated queue API; adding RLS alone does not constrain a privileged database owner connection.

Persist intent before submitting. Following a timeout or crash, look up and reconcile the original fiscal operation before retrying. If the adapter cannot establish whether issuance happened, retain uncertainty for review. Use durable dispatch tracking and idempotent event delivery; do not promise exactly-once fiscal execution merely because the transport retries.

Use outbound authenticated connections from the companion to the cloud; retain the authenticated loopback helper. A local desktop or loopback POS path is needed to queue locally when cloud connectivity is unavailable. The current cloud-only queue cannot deliver new work to a disconnected PC.

The current 400 ms idle poll could approach 216,000 empty checks per worker/day before network latency, plus heartbeats. Use adaptive backoff with jitter or supported push notifications with polling reconciliation. This reduces database load; query counts are not themselves a statement about a Supabase billing quota.

**Developer sales model**

Sell the supported integration, recovery, updates and support. Use a developer/reseller account with merchant subaccounts and a production license for each registered merchant branch/device scope. Keep KRA identity and signing material on the authorized registered runtime; it is not the software license.

The following are proposed pilot prices to test with buyers, not researched market prices or revenue forecasts. State whether tax is included when publishing a price list.

| Offer | Proposed price | Included scope |
| --- | --- | --- |
| Developer sandbox | Free | SDK, simulator, sample apps and documentation; no claim of production fiscal approval |
| Production branch | KES 15,000 onboarding + KES 1,500/month | One registered branch/device scope, updates, reconciliation and standard support with defined limits |
| Developer/reseller | KES 10,000/month minimum, credited toward 10 branches; KES 1,000/additional branch/month | Developer console, merchant subaccounts and standard partner support; reseller sets its retail price |
| OEM/white label | From KES 100,000 setup + negotiated annual minimum | Branding, packaging, agreed connectors and support responsibilities; regulatory approval remains product/scope specific |
| Custom connector | Quoted separately | Integration work, acceptance criteria and a separate maintenance scope |

At the suggested direct price, 50 branches produce KES 75,000/month recurring revenue; at the wholesale price, 50 branches produce KES 50,000/month. These are gross arithmetic examples before hosting, tax, payment fees, installation, support and partner costs. Onboarding revenue is separate. Validate margins with actual support hours before scaling.

Start with a few POS developers and merchant branches. Measure installation effort, failures per 1,000 operations, reconciliation time, support minutes per branch, retention and willingness to pay. Publish supported client/adapter versions and a clear support scope. Avoid an unlimited lifetime support promise.

License the companion with an independently signed entitlement containing developer organization, merchant/branch/device scope, features and expiry. Ship only the license-verification public key. Allow a defined offline grace period and authorized installation transfers. Preserve access to issued receipts, exports and recovery if a subscription expires. Fiscal device migration follows the registered solution's process; copying an installation is not fiscal re-enrollment.

**Hosting economics**

The present zero-invoice infrastructure spend is not a permanent commercial hosting entitlement. Vercel explicitly restricts Hobby to personal, non-commercial use. Its published Pro fee is USD 20/month with one deploying seat and USD 20 usage credit; overages and extras can apply. [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Vercel Pro](https://vercel.com/docs/plans/pro-plan)

Supabase currently lists Free at 500 MB database storage, 5 GB egress and 1 GB file storage, with inactivity pausing; Pro starts at USD 25/month. A simple Vercel Pro + Supabase Pro baseline is therefore about USD 45/month before extras. This is a planning example, not a mandatory minimum for every architecture. Customer-owned hosting can move that bill to the developer/customer but does not eliminate it. [Supabase pricing](https://supabase.com/pricing)

Avoid embedding QR images and receipt copies repeatedly in several database records. Keep one immutable artifact with scoped access and references where practical; define retention and backup requirements before selecting storage.

**Implementation sequence and acceptance criteria**

1. **Foundation:** authorization, scoped enrollment/claims/writeback, credential replacement, TLS verification, honest readiness, verified product data and decimal reconciliation. Accept only after two isolated merchant fixtures cannot access or process each other's work.
2. **Reliability MVP:** idempotency uniqueness, durable intent, lease recovery, evidence-backed status and inventory aggregation. Inject crashes before issuance, after issuance, before dispatch, after dispatch and during cloud writeback. The result must be recovery of the same operation or explicit uncertainty, never automatic fresh issuance from an ambiguous state.
3. **Commercial integration:** implement and test the documented adapter, complete the relevant KRA certification process and validate genuine transmission/acceptance in its approved environment. Ship SDK, simulator, licensing and support documentation against that interface.
4. **Expansion:** original-solution credit notes, purchases/stock reconciliation, developer console, selected connectors and white-label packaging. Add each operation only after its semantics and recovery behavior are verified.

Also test same-key/different-payload conflicts, simultaneous requests, repeated SKUs, fractional quantities, discounts, mixed supported tax categories, shortages, partial returns and incompatible client upgrades. These are proposed tests, not tests performed during this investigation.

**Question coverage and limits**

| Question | Result |
| --- | --- |
| Which existing components can support expansion? | Answered from available source. |
| What blocks safe multi-merchant distribution? | Answered at source-review level; deployment-wide controls and live database constraints remain unverified. |
| Which extra features offer practical value? | Answered with prioritized design proposals and documented KRA capability boundaries. |
| How should developers integrate and pay? | Answered with an API proposal, reseller licensing model and explicitly hypothetical prices. |
| Is direct Paypoint writing an approved integration? | Not established by reviewed public documentation; no certification assertion made. |
| Do current invoices reach and get accepted by KRA? | Unresolved; no live submission or acceptance check performed. |
| Is the quoted sub-300 ms time end-to-end? | Unresolved; no new benchmark. Measure local engine, full checkout and central acknowledgement separately. |
| Does all deployed executable behavior match this source? | Unresolved; only the deployed Node worker was matched by hash. |
