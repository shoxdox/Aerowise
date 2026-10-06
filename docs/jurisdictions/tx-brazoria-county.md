# Brazoria County Environmental Health, OSSF (`tx-brazoria-county`): draft profile

Status: **draft**. v1 was written 2026-10-06, when most county pages returned 403. v2 (W12.C6, same day) adds the Environmental Health Contact Us page, the county's approved OSSF order and its fee schedule, from [the 2026-10-06 research packet](research/2026-10-06/authorities/tx-brazoria-county.md) (findings B1 to B5). The Contact Us page sends maintenance reports and contracts to ehmaintenance@brazoriacountytx.gov, so Brazoria reports and contracts are drafted to that address and go only when the office presses Send.

## Questions for Justin

Each of these is open in `profile.unresolved`. Brazoria County Environmental Health can answer them: 979-864-1600.

1. **Does the county accept Aerowise's report layout and typed signatures at ehmaintenance@brazoriacountytx.gov, and does it acknowledge what it receives?** The address is published; acceptance is not.
2. **Is registration still in person on the county's form (order 10(b)), or is there now an emailed or online process?**
3. **Which cities run their own program or defer to TCEQ (Manvel, Brookside Village, Surfside Beach, Pearland and others)?**
4. **Can any fee apply to a maintenance report or contract, including a late one?** The fee schedule lists none, and the order has a general fee clause.
5. **Is there a county report form, a commercial schedule or lab testing beyond 30 TAC 285.7?**

## Evidence gaps and conflicts

- The Contact Us page's email link is broken (a mailto with no address), but the address is printed in its OSSF Maintenance section. Read from a browser excerpt in the research packet.
- v1 refused to use ehmaintenance@ because no official page carrying it could be read. v2 uses it because the county's own page now shows it; that is still not acceptance (question 1).
- The authorized agents inside the county come from TCEQ's 2023 and 2024 permit reports, which list only agents that issued permits that year.

## Identity

- key: `tx-brazoria-county`, ruleset v2 (v1 kept as published; v2 applies from the same day, 2026-10-06)
- state: TX
- authority: Brazoria County Environmental Health Department, On-Site Sewage Facilities (TCEQ authorized agent 620020)
- requirement in effect (the legal date): 2010-06-30, the TCEQ's approval of the county's order, adopted 2010-06-10 (PDF pp. 1-2, 12). Later amendments were not checked.
- rule activation in Aerowise (a different thing): `effectiveFrom` 2026-10-06. Nothing earlier is backdated, and existing contracts and filings are not rewritten.
- source links (all read 2026-10-06):
  - Contact Us: https://www.brazoriacountytx.gov/departments/environmental-health/contact-us
  - OSSF order: https://www.brazoriacountytx.gov/home/showpublisheddocument/1190/635938334219200000
  - Fee schedule: https://www.brazoriacountytx.gov/home/showpublisheddocument/13662/637686168999830000
  - OSSF Permitting Process: https://www.brazoriacountytx.gov/departments/environmental-health/forms-permit-applications/ossf-permitting-process
  - Forms & Permit Applications: https://www.brazoriacountytx.gov/departments/environmental-health/forms-permit-applications
  - TCEQ 2024 authorized-agent permit report: https://www.tceq.texas.gov/downloads/permitting/ossf/reporting-system/2024-aa-atcs.pdf
  - 30 TAC 285.7: https://www.law.cornell.edu/regulations/texas/30-Tex-Admin-Code-SS-285-7 (last amended effective 2023-07-06)
  - TCEQ maintenance page: https://www.tceq.texas.gov/permitting/ossf/ossfmaintenance.html (last modified 2026-03-03)

## Applicability

Section 6 of the order: Brazoria County outside incorporated cities and areas under an existing rule. Brookside Village, Manvel and Surfside Beach are separate authorized agents, and Pearland sends OSSF applications to TCEQ Region 12. `assignment: "reviewed"`: the office checks the site's permit and records what it checked.

## Service frequency

Every 4 months, or every 6 months with electronic monitoring on record (30 TAC 285.7(e)). Sections 8-9 of the order adopt the TCEQ's rules.

## Lab tests

None found (question 5).

## Filing deadline

14 days after the inspection (30 TAC 285.7(e)), warning 5 days before.

## Required inspection fields

None beyond the template's own (which include the chlorine residual).

## Required attachments/photos

None published.

## Required report/form

None found (question 5).

## Submission method

Email, drafted by Aerowise and sent only when the office presses Send (`autoSubmit: false` while the profile is a draft). Reports and contracts each have their own subject line.

## Destination / portal

ehmaintenance@brazoriacountytx.gov, from the Contact Us page's OSSF Maintenance section.

## Customer copy requirement

Required (30 TAC 285.7(e)).

## Confirmation / proof

None published (question 1). The sent email is the proof until the county says otherwise.

## Contract requirements

The Contact Us page sends maintenance contracts to the same address. Renewal timing comes from 30 TAC 285.7(d)(2): 30 days before the current contract expires. No contract or late fee is set (question 4).

Providers register with the Environmental Health Department in person on its standard form, free, before working (order 10(b)). v2 records this as `provider.countyRegistration`; Aerowise does not record a company's registration, so the office checks it (question 2).

## Exceptions

No permit is needed for a single-family OSSF on a single tract of ten acres or more that meets the setbacks. A homeowner may maintain their own system only with qualifying training or a listed license (order 10(g)); that is not an exemption from reporting. An owner starts a repair within ten days of notice (order 10(g)), which is not a report deadline.

## Test fixtures

`apps/api/test/brazoria.test.ts` covers these cases:
- v2 reads as written and replaces v1 from 2026-10-06; v1 (no channel) is unchanged
- a valid inspection: due 14 days later, next visit in 4 months, held until credentials and signature are in place, then ready, emailed to ehmaintenance@ only after Send
- a signed contract: ready, emailed to the same address with the contract subject only after Send
- a missing chlorine residual, which keeps the inspection a draft
- the 6-month schedule with monitoring on record
- a Brazoria site never matched by county alone

## Verification

Draft. To verify, follow TEMPLATE.md once the county answers question 1.
