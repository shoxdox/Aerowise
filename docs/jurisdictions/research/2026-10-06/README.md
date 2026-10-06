# Aerowise county evidence packet — October 6, 2026

**Promising: AI can do substantially more of this research before Justin calls anyone.** Original downloads, browser navigation, OCR, court attachments and page-by-page checks recovered information the earlier pass treated as unavailable. Some remaining questions are product implementation gaps, not research blockers.

This packet is a research handoff, not an approved compliance configuration. No county was contacted, no report was filed, and no application code or published ruleset was changed.

## Start here

- [Claude handoff](CLAUDE-HANDOFF.md): concise context and proposed next work.
- [Remaining confirmation questions](remaining-questions.md): targeted questions after public-source research.
- [Authority reviews](authorities/tx-williamson-county.md): each review contains original-document links, page references, confidence and baseline question dispositions. Other reviews are linked below.
- [Source manifest](source-manifest.json): official URL, retrieval time, original file, SHA-256, page counts, text/OCR coverage and visually checked pages.
- [Structured findings](findings.json) and [all baseline dispositions](question-dispositions.json): reusable evidence, with every item marked unimplemented and authority acceptance unconfirmed.
- [Packet statistics](packet-stats.json) and [source index](SOURCE-INDEX.md).

## What changed our understanding

**[Williamson](authorities/tx-williamson-county.md):** the approved order establishes May 7, 2021 TCEQ approval and required pump-tank sludge reporting. A current homeowner packet uses a dedicated contracts inbox, while the linked affidavit and homeowner form give different deadline anchors. The affidavit visibly prints a future update date, September 9, 2028. That anomaly needs confirmation; it is not an effective date.

**[Comal](authorities/tx-comal-county.md):** its 13-page scanned rules are now readable. Final TCEQ approval is November 26, 2013. The local additions do not establish a different recurring maintenance schedule in this order. Five city agreements provide stronger assignment evidence. Report and contract upload destinations are already public; exact format and receipt remain open.

**[Hays](authorities/tx-hays-county.md):** the original order establishes February 18, 2014 approval. Contract-start/end inspections, provider changes, annual county registration, prior-report completeness and corrective reports need dedicated handling. A blanket monitored six-month schedule is not supported by the local four-month-unless-permit wording. The 2026 fee schedule lists a $50 maintenance-contract late fee. A dedicated maintenance inquiry address was found, but its label alone does not authorize recurring filings there.

**[Travis](authorities/tx-travis-county.md):** original code pages confirm extra report/contract fields. The draft’s 1,000-foot LCRA boundary conflicts with the county checklist and LCRA’s own 2,000-foot zone description. Use the actual permit and jurisdiction map, not county name or distance from today’s shoreline.

**[Brazoria](authorities/tx-brazoria-county.md):** the live county contact page explicitly directs both maintenance reports and contracts to `ehmaintenance@brazoriacountytx.gov`. The browser also recovered its adopted order, final June 30, 2010 TCEQ approval, and county provider registration requirements. The registration is free under the posted order; current registration procedure still needs checking.

**[Grimes](authorities/tx-grimes-county.md):** a certified August 21, 2024 adopted order was found in official court records. It states four-month reporting and adds pump-tank sludge/pH and spray-area condition. The TCEQ attachment found is permission to proceed on a proposed draft, not final approval. Exact effective date remains open.

**[Montgomery](authorities/tx-montgomery-county.md):** the live county site publishes a local order approved by TCEQ March 4, 2021. It supports annual commercial/multifamily BOD/TSS testing and county provider status. A separately linked food-establishment initial contract requires monthly visits, unlike the general four-month initial contract. Its old revision date and post-initial-term policy need checking before use.

**[Denton](authorities/tx-denton-county.md):** fresh originals were not obtained. Requests returned rate limiting and the browser presented verification. Retrieval stopped, so prior Denton source claims remain unverified in this packet.

Some of these requirements were already recognized in Aerowise’s drafts. The contribution here is original-source verification, better scope, recovered dates/documents, newly surfaced conflicts, and a smaller confirmation queue—not a claim that every finding is new.

## Scope and limits

Eight authorities reviewed: Williamson, Denton County, Comal, Hays, Travis, Brazoria, Grimes and Montgomery. This is not a statewide audit of all 21 real draft authorities. The repo baseline is main commit `39298979ebd8cc89d9027f78b1f51fc6a313b5c2`, with 22 ruleset files: 21 real drafts and one fictional demo. The earlier brief’s 13-plus-10 split should be refreshed against that inventory.

The packet reassesses 56 `profile.unresolved` entries from those eight profiles. Dispositions distinguish public evidence, partial answers, conflicting instructions, implementation gaps, unresolved matters and access blocks. They are not 56 county-approved answers. See the statistics file for actual counts.

PDFs with no text and hybrid PDFs were rendered and OCRed where needed. Key pages supporting important findings were visually checked; not every archived page was visually inspected. OCR is derived and can misread numbers, dates and handwritten signatures. The manifest identifies coverage precisely. Browser-only excerpts are labeled as derived captures; they are not represented as original HTML downloads. Duplicate source records share hashes and are identified in the manifest.

The Desktop ZIP includes the original source files, extracted text/OCR, inputs and written handoff. Intermediate page-render PNGs remain in this repo folder under `rendered/` and are omitted from the ZIP to keep the transfer smaller. The original scanned PDFs are included.

Published documents do not demonstrate acceptance of an Aerowise-generated report, current good standing of a specific provider, the right authority for a particular parcel, or absence of later amendments/permit conditions. The repo’s existing verification policy still applies: human authority confirmation, unresolved issues closed, and Justin’s verification step. No profile was marked verified.

## The useful next move

Select one real provider and a small set of actual permits, signed contracts and previously accepted reports. Compare our generated output against those before broadening coverage. That gives us the missing dates, authority assignments, special conditions and accepted format. Then ask the chosen authority a short, evidence-backed confirmation question, rather than asking it to explain its whole program.

The repeatable research workflow is: discover current official links → preserve originals/hashes → extract text → detect scanned pages → OCR → visually check decisive pages → record field-level evidence/conflicts → compare to the draft → request only the remaining confirmation. It can be automated further once the first pilot establishes which sources and changes actually matter. No recurring monitoring was scheduled in this pass.
