#!/usr/bin/env python3
"""Build a research handoff from authored findings; never edits application rules."""
import json, pathlib, collections, hashlib, subprocess
from bs4 import BeautifulSoup

ROOT = pathlib.Path(__file__).resolve().parent
manifest = json.loads((ROOT/'source-manifest.json').read_text())
baseline = json.loads((ROOT/'baseline.json').read_text())
by_id = {r['id']:r for r in manifest}
findings = []
def add(aa, key, title, status, evidence, action, refs, confidence='high'):
    findings.append(dict(id=key, authority='tx-'+aa+'-county', title=title,
                         status=status, confidence_in_source_reading=confidence,
                         evidence=evidence, proposed_action=action,
                         sources=[dict(id=s, location=loc) for s,loc in refs],
                         authority_confirmation=False, implemented=False))

add('williamson','W1','The approved order is available','public_evidence',
    'The current county copy includes final TCEQ approval issued May 7, 2021 and the adopted order. County adoption was January 12, 2021. The earlier agenda PDF omitted the approval pages.',
    'Replace the missing-approval research claim. Distinguish the order effective date from when a new Aerowise ruleset is activated; do not backdate records automatically.', [('williamson-order','PDF pp. 1–2, 13')])
add('williamson','W2','Sludge and spray-area reporting are already required','implementation_gap',
    'Section 10.E.7 requires pump-tank sludge levels and the condition of the spray area on each required testing report. The homeowner form also supplies a sludge measurement in inches and a surface-application chlorine test.',
    'Treat sludge capture/reporting as a documented implementation gap. Keep units and system applicability explicit; notes are an interim manual workaround, not proof the generated template meets the requirement.', [('williamson-order','PDF p. 10, §10.E.7'),('williamson-homeowner','PDF p. 4')])
add('williamson','W3','Current homeowner filing instructions differ from the draft','partial',
    'The homeowner self-maintenance packet linked by the live site, updated August 21, 2026, directs reports to ossfcontracts@wilcotx.gov. It retains ossf@wilcotx.gov in the header/footer. This is specifically a homeowner packet, not express provider submission guidance.',
    'Refresh the source reference. Ask whether providers use the dedicated inbox for reports and contracts; do not infer provider authorization solely from the homeowner form.', [('williamson-homeowner','PDF pp. 4–5')])
add('williamson','W4','Deadline conflict and a future-dated footer remain','conflict',
    'The linked affidavit says reports within 10 days of testing; the homeowner packet says within 14 days of the due date. The affidavit visibly prints Updated 9/9/2028, later than this research date. Its body also says contracts 30 days before expiration or within 30 days after transfer.',
    'Preserve both scoped deadlines and the date anomaly. Keeping an earlier internal target is reasonable but does not settle the legal anchor. Ask the county for current provider timing and a corrected/current affidavit.', [('williamson-affidavit','PDF pp. 1–2'),('williamson-homeowner','PDF p. 4'),('williamson-care','brochure contract timing')])
add('williamson','W5','License fee is distinct from report filing','public_evidence',
    'The posted fee schedule lists $60 for aerobic license renewal or transfer. The affidavit describes a two-year operating license and current report/contract requirements on transfer. Absence of a report fee on this schedule does not establish universal free filing.',
    'Keep owner operating-license renewal, maintenance-contract renewal, and report submission as separate events. Confirm any filing fee and receipt practice for the pilot.', [('williamson-fees','PDF p. 1'),('williamson-affidavit','PDF p. 2')])

add('denton','D1','Fresh document retrieval was blocked','access_blocked',
    'Direct county document requests returned HTTP 429; the browser then presented a Cloudflare verification screen on the document and maintenance pages. Further Denton retrieval stopped. No CAPTCHA was solved and no original maintenance form/order was obtained in this pass.',
    'Retain previous Denton statements as baseline claims awaiting original-source verification. Use an existing provider copy or request the current order, form, contract channel and acceptance requirements from the county.', [],'not established')

add('comal','C1','The scanned rules are readable and approval is established','public_evidence',
    'The 13-page official scan includes county adoption October 24, 2013 and final TCEQ approval November 26, 2013. Sections 8–9 incorporate TCEQ rules and future amendments. The local additions in §10 concern construction/siting; this order does not add a different recurring maintenance interval, report deadline, report template or lab schedule.',
    'Remove the scan-is-unreadable blocker. Keep permit-specific requirements and later amendments as a separate check; do not turn absence in this order into proof no other requirement exists.', [('comal-rules','PDF pp. 6–7, 10–13')])
add('comal','C2','County role inside five cities has documentary support','partial',
    'The county publishes intergovernmental agreements for Bulverde, Fair Oaks Ranch, Garden Ridge, Schertz and Spring Branch. They describe county OSSF permitting/inspection/enforcement functions. The agreements for multi-county cities limit exclusive county service to the Comal portion. Termination/renewal provisions mean publication alone is not proof of current coverage for every address.',
    'Use these agreements as assignment evidence alongside the actual site permit. Confirm any termination or superseding agreement; never assign solely by city name or county.', [('comal-bulverde','PDF pp. 1–2'),('comal-fair-oaks','PDF pp. 1–2'),('comal-garden-ridge','PDF pp. 1–2'),('comal-schertz','PDF pp. 1–2'),('comal-spring-branch','PDF pp. 1–3')])
add('comal','C3','Separate provider upload destinations are published','public_evidence',
    'The live Environmental Health page links separate Files.com uploads for maintenance reports and maintenance contracts, with provider name, email and TCEQ license number requested. No report-format approval or receipt semantics were established by this research.',
    'Retain manual export/upload. Obtain the accepted format, signature and upload receipt details using a reviewed sample before calling a filing accepted.', [('tx-comal-county-source-1','Environmental Health page, maintenance report/contract instructions')])
add('comal','C4','Spray-area obstruction rule is useful to field work','public_evidence',
    'Section 10.9 prohibits items such as picnic tables, play equipment and BBQ pits within the surface application spray area. The order and current saved OSSF Information page do not substantiate the draft assertion that self-maintaining homeowners submit no reports.',
    'Use spray-area condition as a field check. Keep the homeowner no-report exception unconfirmed until a current primary source or county reply supports it.', [('comal-rules','PDF p. 12, §10.9'),('tx-comal-county-source-2','current OSSF Information page')])

add('hays','H1','Approval date is present in the original','public_evidence',
    'The official regulations include final TCEQ approval issued February 18, 2014; county adoption was June 4, 2013.',
    'Replace the missing-effective-date research claim, while preserving a distinct application activation date and checking for later amendments.', [('hays-regulations','PDF pp. 1–2')])
add('hays','H2','Contract-based timing needs implementation','implementation_gap',
    'Section 10.V.2 requires tests/reports every four months unless the permit specifies otherwise. First testing and report submittal are within 14 days of contract start, later dates derive from that start, and the last testing/reporting is within 14 days of contract end. Changing providers requires a renewal term of at least one year and four inspections including the initial inspection.',
    'Do not model Hays as only last-visit-plus-four-months. Review first/last windows, provider changes and permit overrides. Disable an unconditional six-month assumption in a proposed new version until its permit/local basis is established.', [('hays-regulations','PDF p. 19, §10.V.2')])
add('hays','H3','Provider registration and renewal prerequisites are documented','implementation_gap',
    'Section 10.V.3 makes county provider registration annual, expiring December 31, with next-year renewals accepted no earlier than December 1 and no registration fee. Contracts are accepted only from current providers in good standing. Section 10.V.6 prevents same-provider renewal acceptance until all prior-period reports have been submitted.',
    'Track county registration separately from state credentials, and flag prior report completeness before renewal. Do not imply a TCEQ license alone satisfies this county prerequisite.', [('hays-regulations','PDF pp. 19–20, §10.V.3 and V.6')])
add('hays','H4','Corrective reports have their own clock','implementation_gap',
    'Section 10.V.4 requires correction, retesting and another report to the owner and county within ten days of the previous report when chlorine is inadequate or the system is malfunctioning. Extra reports must not postpone the regular maintenance schedule.',
    'Represent a corrective retest/report separately from normal scheduling. Preserve the source wording previous report; do not silently anchor it to a visit or reset the ordinary due date.', [('hays-regulations','PDF p. 19, §10.V.4')])
add('hays','H5','Maintenance contact found; channel acceptance still needs confirmation','partial',
    'The live Development Services contact page publishes ossfmaintenance@hayscountytx.gov for OSSF maintenance inquiries, phone 512-393-2150 option 0. The 2026 fee schedule says applications/documents are handled online through MGO. Neither establishes that all recurring reports/contracts may be emailed.',
    'Use the dedicated inquiry contact to confirm report/contract destinations, approved format and receipt. Do not enable email dispatch from an inquiry label.', [('hays-contact-browser-excerpt','Permit Administration'),('hays-fees','PDF p. 1, heading')])
add('hays','H6','A maintenance-contract late fee is published','public_evidence',
    'The January 1, 2026 fee schedule lists a $50 OSSF maintenance contract late fee. It separately lists $600/$900 OSSF renewal with a designer no-change letter; that entry must not be treated as a routine maintenance-contract renewal charge. The exact late-fee trigger was not established.',
    'Add the late-fee source to the research draft and confirm its trigger. Keep permit fees separate. Commercial/institutional/non-residential systems also require a flow meter under §10.W.6.', [('hays-fees','PDF p. 1'),('hays-regulations','PDF p. 20, §10.W.6')])

add('travis','T1','Additional report and contract fields are mandatory in the chapter','implementation_gap',
    'Chapter 448 §448.034(e) requires unauthorized alterations, applicable spray-area condition, permit number, printed name/signature, site physical address and provider physical/business addresses, business phone and emergency phone. Contracts have additional fields under (f). The section begins with a single-family applicability statement; commercial applicability should be reviewed separately.',
    'Convert questions about unauthorized alterations and emergency contact into documented template/data gaps for the scoped workflow. Do not infer a typed name meets signature acceptance or that the exact format is approved.', [('tx-travis-county-source-1','PDF pp. 12–14, §448.034(a), (e), (f)')])
add('travis','T2','The 1,000-foot Lake Travis boundary claim is contradicted','conflict',
    'The county non-residential checklist states LCRA review within 2,000 feet of the 691-foot contour. LCRA’s own program describes a 2,000-foot Lake Travis zone. Its order §6 defines the below-691-foot restricted zone and a water-quality zone within 2,000 horizontal feet from the outer restricted-zone boundary in the drainage area. This contradicts a simple 1,000-foot exclusion in the draft.',
    'Correct the research claim and require permit/map-based reviewed authority assignment. Consult LCRA’s jurisdiction map for candidate sites and seek a determination where unclear; do not approximate the contour with a present shoreline distance.', [('travis-nonres-checklist','PDF p. 4, item 21'),('lcra-ossf-program','program jurisdiction paragraph'),('lcra-order','§6 Area of Jurisdiction')])
add('travis','T3','Code effective-date evidence is stronger than a retrieval date','public_evidence',
    'Chapter 448 identifies amendments adopted November 28, 2023, effective July 16, 2024 on TCEQ approval. The copy also gives the earlier chapter effective date February 23, 2015.',
    'Keep amendment dates attached to affected provisions rather than assuming every provision began in 2024. Maintenance destination/format/receipt and commercial lab requirements remain unsettled in this pass.', [('tx-travis-county-source-1','PDF p. 1 and amendment footnotes')])

add('brazoria','B1','Maintenance report and contract email destination is explicit','public_evidence',
    'The live Environmental Health Contact Us page expressly directs maintenance contracts and reports to ehmaintenance@brazoriacountytx.gov. The email link itself is malformed (mailto: with no address), but the rendered address is visible and explicit. Phone is 979-864-1600.',
    'Replace the no-published-channel claim with this public destination evidence. Report format, signature acceptance and an accepted receipt still require a reviewed sample/confirmation before production dispatch.', [('brazoria-contact-browser-excerpt','OSSF Maintenance section')])
add('brazoria','B2','Approved county order and scope recovered','public_evidence',
    'The order linked by the live regulations page includes county adoption June 10, 2010 and final TCEQ approval June 30, 2010. Section 6 excludes incorporated cities and areas regulated under an existing rule. Sections 8–9 adopt TCEQ rules and future amendments.',
    'Remove the unreadable-order/unknown-date blocker. Confirm later amendments and actual permit authority for pilot sites; a historical statewide permit-count report is not a current city coverage list.', [('brazoria-order','PDF pp. 1–2, 6, 12')])
add('brazoria','B3','County provider registration is required and free in the order','implementation_gap',
    'Section 10(b) requires TCEQ credentials plus registration with the county Environmental Health Department before installer/provider activity. The order prescribes an in-person standard form with evidence of current credentials, no registration fee, current registration information, and restrictions when suspended/revoked. Homeowners are exempt from this registration requirement, not from all maintenance conditions.',
    'Track county registration/good standing. Confirm whether an online/email process now replaces the printed in-person procedure. Do not ask whether registration exists as if wholly unknown.', [('brazoria-order','PDF p. 7, §10(b)')])
add('brazoria','B4','Homeowner qualifications and repair response are documented','public_evidence',
    'Section 10(g) requires qualifying homeowner training or specified licensing/manufacturer certification, with historical exceptions and loss conditions. It also requires an owner to initiate malfunction repair within ten days after Designated Representative notification. Section 10(f) concerns the recorded affidavit.',
    'Do not encode a blanket homeowner exemption or confuse repair initiation with report submission timing. County report format, commercial lab details, filing fees and acknowledgments remain separate questions.', [('brazoria-order','PDF p. 10, §10(f)–(g)')])
add('brazoria','B5','Fee evidence has limits','partial',
    'The linked fee schedule lists OSSF permit/reinspection charges, and the order has a general collection clause covering multiple fee types. No routine maintenance report/contract filing amount was identified in the retrieved schedule. This does not prove no maintenance-related fee can apply.',
    'Ask a specific fee/late-fee question rather than setting a zero charge on absence alone.', [('brazoria-fees','derived text, OSSF section'),('brazoria-order','PDF p. 11, §12')])

add('grimes','G1','A newer adopted local order was recovered','partial',
    'The official August 21, 2024 court record includes a certified adopted OSSF order and a passed adoption motion. Its effective clause requires TCEQ approval. The July 29, 2024 TCEQ attachment is a notice to proceed on a proposed draft, not final authorization after adoption.',
    'Replace the newspaper-only/2023/order-not-found claim. Request the final TCEQ approval before asserting an effective date or deciding which historical records the 2024 requirements cover.', [('grimes-2024-order','PDF pp. 1, 6–7'),('grimes-adoption-minutes','August 21, 2024 adoption motion'),('grimes-tceq-notice','PDF p. 1')])
add('grimes','G2','The adopted order says four months and adds pH/sludge','implementation_gap',
    'Section 9.C.1 requires maintenance/testing/reporting at least every four months, with reports submitted to the Designated Representative, including pump-tank sludge levels and pH and spray-area condition. No six-month monitoring exception appears in this local provision. Final approval/effective-date evidence remains incomplete.',
    'Flag the draft six-month fallback and missing fields for review. Do not auto-pass a six-month schedule based solely on state monitoring guidance. Preserve the effective-date uncertainty; do not invent pH units or pass/fail thresholds.', [('grimes-2024-order','PDF pp. 4–5, §9.C.1')])
add('grimes','G3','Homeowner qualification is not wholly unknown','partial',
    'Section 9.B describes homeowner eligibility through licensing/registration or TEEX training and evidence to the Designated Representative, with loss of eligibility for failures/falsification/violations. This is more specific than the draft claim that no qualification rule was published.',
    'Attach the actual eligibility provision to the draft, subject to the missing final approval and any later amendments. Provider approval/registration workflow still needs clarification.', [('grimes-2024-order','PDF p. 4, §9.B')])
add('grimes','G4','The affidavit renewal sentence is now complete','partial',
    'The original 2024 affidavit calls for continuous maintenance and a signed contract submitted within 30 days after property transfer, upon renewal, or upon changing providers. The full sentence is readable; it does not settle how its timing relates to the state pre-expiration requirement.',
    'Remove the summarizer-truncation blocker. Preserve the complete language and confirm renewal/provider-change timing and destination. The Microsoft form found on the county page is for complaints, not recurring maintenance filings.', [('tx-grimes-county-source-3','PDF p. 1'),('tx-grimes-county-source-1','Environmental Permits page')])

add('montgomery','M1','The live site publishes an approved local order','public_evidence',
    'The live OSSF page links an 11-page order packet. It includes county adoption December 8, 2020 and final TCEQ approval March 4, 2021. The first two pages have text; most of the actual local order is scanned. A file number such as 620145 is not an order identifier.',
    'Remove the no-order/no-effective-date/website-unreadable claim. Use the adopted title and dates; check later amendments and retain a distinct Aerowise activation date.', [('montgomery-local-order','PDF pp. 1–2, 4–11'),('montgomery-ossf-page','Local Order link')])
add('montgomery','M2','Commercial/multifamily annual lab testing has order support','public_evidence',
    'Section 10(j) requires annual BOD and TSS for all commercial and multifamily OSSFs. It also restricts aerobic homeowner maintenance to a Certified Maintenance Provider, defined in §10(a)(1) to include TCEQ and county status. The order does not supply BOD/TSS limits or lab filing format in this provision.',
    'Scope annual lab tracking to the explicit categories and actual permit; ask for limits, lab attachments, due-date anchor and submission practice rather than whether the annual obligation exists.', [('montgomery-local-order','PDF pp. 6–8, §10(a)(1), (j)')])
add('montgomery','M3','The initial contract remains a scoped source','partial',
    'The previously cited readable county initial contract requires three inspections each year, one every four months, during the initial two-year period and reports within 14 days after the test. The live site also links new residential/general and food-establishment initial contract scans, archived here for comparison. The adopted order does not settle a separate recurring post-initial monitoring interval in §10(j).',
    'Do not treat an initial contract as proof of renewal-period policy. Confirm whether six-month monitored schedules are permitted after the initial term and what current renewal terms require.', [('tx-montgomery-county-source-1','PDF p. 1'),('montgomery-local-order','PDF pp. 7–8, §10(j)'),('montgomery-new-initial-contract','live form, PDF p. 1'),('montgomery-food-contract','live food form, PDF p. 1')])
add('montgomery','M4','Better contacts found, but no explicit maintenance filing channel','partial',
    'The live OSSF page names supervisor Keith Miles at keith.miles@mctx.org, phone 936-539-7839. The All Forms page publishes mc.maint@mctx.org for open-record requests involving septic-connected structures. That is narrower than authorization for recurring reports/renewal contracts.',
    'Use the supervisor or records contact to request the missing submission/renewal instructions and sample acceptance. Do not repurpose a complaint inbox or infer dispatch authorization from an address containing maint.', [('montgomery-ossf-page','OSSF Supervisor contact'),('montgomery-forms-page','Open Records Request instruction')])
add('montgomery','M5','Jurisdiction exclusions and fee evidence are more concrete','partial',
    'Section 6 excludes existing-rule areas and incorporated cities, adding cities that execute intergovernmental contracts with the county. The live fee schedule has permit/reinspection entries and a $200 septic non-compliance administrative fee per incident; it does not identify a recurring maintenance filing fee. The downloaded SJRA order is a separate authority source, not Montgomery’s order.',
    'Review city/county/SJRA authority against each permit. Ask whether the non-compliance fee can apply to late maintenance filings and obtain the applicable agreement/boundary basis; do not infer a routine filing charge.', [('montgomery-local-order','PDF p. 5, §6'),('montgomery-fees','PDF p. 2, SEPTIC section'),('tx-montgomery-county-source-4','SJRA order, §5')])
add('montgomery','M6','Food-establishment initial contracts require monthly inspections','implementation_gap',
    'The commercial food-establishment initial two-year contract linked by the current All Forms page requires at least twelve inspections per year, one every month, and report submission to owner/authority within 14 days after testing. The scan is an older form (revised November 25, 2009) still linked today. The general initial contract instead says three yearly visits/every four months.',
    'Do not use one residential four-month schedule for all Montgomery sites. Flag food establishments for permit/contract review and model the monthly initial-term schedule when applicable. Confirm whether the older linked form remains controlling and what follows the initial term.', [('montgomery-food-contract','PDF p. 1'),('montgomery-new-initial-contract','PDF p. 1'),('montgomery-forms-page','two separately labeled initial contract links')])

# One disposition for every baseline unresolved-array entry, in original order.
# These are array indexes, not the separately numbered Questions for Justin.
answers = {
'williamson': [
 ('partial','W3','Current dedicated inbox found in homeowner packet; provider channel still unconfirmed.'),
 ('conflict','W4','Both different anchors remain; current affidavit also has a future-dated footer.'),
 ('conflict','W4','Affidavit supports pre-expiration target; brochure wording does not resolve all timing.'),
 ('implementation_gap','W2','Already required by the approved order; adding the field is a product task.'),
 ('implementation_gap','W2','Current form confirms surface-application applicability and sludge units.'),
 ('partial','W1','Order establishes exclusions, but actual Austin/site assignment still needs permit evidence.'),
 ('public_evidence','W1','Final TCEQ approval recovered; prior scan/summarizer barrier removed.'),
 ('not_resolved','W2','Commercial lab/schedule applicability still requires state/permit-specific review.'),
 ('not_resolved','W5','A received/accepted report acknowledgment was not established.')],
'denton': [('access_blocked','D1','Fresh original verification was blocked; retain the baseline as unverified.')]*8,
'comal': [
 ('public_evidence','C1','Scanned order recovered/read; no different recurring maintenance rule found in its local amendments.'),
 ('partial','C2','Five published agreements recovered; current status and actual site assignment remain reviewable.'),
 ('not_resolved','C3','Exact upload format/signature/name conventions remain unconfirmed.'),
 ('public_evidence','C1','County adoption and final TCEQ approval dates recovered.'),
 ('not_resolved','C3','Upload receipt and county acceptance semantics remain unconfirmed.'),
 ('partial','C1','No additional maintenance lab schedule found in this order; state and permit conditions still require applicability review.')],
'hays': [
 ('partial','H5','Dedicated maintenance inquiry address found; explicit report/contract filing authorization still needed.'),
 ('not_resolved','H1','Actual address/city authority still requires permit and assignment evidence.'),
 ('implementation_gap','H2','Contract-start timing is documented; existing generic scheduling needs review.'),
 ('implementation_gap','H4','Ten-day corrective report/retest obligation read, separate from the regular schedule.'),
 ('partial','H2','Local text says four months unless permit specifies otherwise; blanket six-month fallback is unsupported.'),
 ('public_evidence','H1','Final TCEQ approval recovered.'),
 ('partial','H6','2026 schedule confirms a $50 maintenance-contract late fee; exact trigger, report format and receipt remain open.'),
 ('implementation_gap','H6','Commercial flow-meter obligation documented; lab/permit conditions remain a separate review.')],
'travis': [
 ('not_resolved','T3','No explicit recurring maintenance filing channel established in reviewed material.'),
 ('conflict','T2','1,000-foot claim contradicted by county checklist and LCRA primary sources; review actual permit/map.'),
 ('implementation_gap','T1','Chapter already requires alterations and emergency contact in the scoped reports/contracts.'),
 ('public_evidence','T1','Quoted field lists compared with original PDF text and visually checked on physical pages 13–14.'),
 ('not_resolved','T3','Acknowledgment of a received maintenance filing was not established.'),
 ('not_resolved','T3','Commercial lab/testing was not settled by this pass.')],
'brazoria': [
 ('public_evidence','B1','County expressly publishes email for maintenance contracts and reports.'),
 ('partial','B2','Approved local order and fee schedule recovered; exact report/lab practices and fee triggers remain open.'),
 ('implementation_gap','B3','County registration process and no registration fee are documented; current operational procedure still needs confirmation.'),
 ('partial','B2','Order supplies city exclusion; actual authority assignment still needs site permit/evidence.'),
 ('public_evidence','B1','Official contact page establishes Environmental Health phone 979-864-1600.'),
 ('not_resolved','B1','County acknowledgment/accepted receipt not established.')],
'grimes': [
 ('partial','G4','County OSSF page now readable, but report/contract destination still not established.'),
 ('partial','G1','2024 adopted order recovered; final TCEQ approval/effective date still missing.'),
 ('partial','G3','Adopted order supplies qualifications; final approval and approval workflow remain open.'),
 ('not_resolved','G1','Todd Mission/city receiving authority still requires site-specific confirmation.'),
 ('public_evidence','G4','Original affidavit and order read; summarizer truncation/scan barriers removed.'),
 ('not_resolved','G4','Acknowledgment of maintenance filings not established.')],
'montgomery': [
 ('partial','M4','Live pages accessible; better contacts found, but explicit recurring filing channel still absent.'),
 ('partial','M3','Initial-term wording confirmed; renewal/monitoring treatment not established.'),
 ('partial','M2','Annual commercial/multifamily BOD/TSS confirmed in order; limits/lab format still unknown.'),
 ('public_evidence','M1','Approved local order and approval dates recovered.'),
 ('partial','M5','County exclusions established; city/SJRA actual assignments still need permit/boundary evidence.'),
 ('public_evidence','M1','Original documents read, scanned local provisions OCRed and key pages visually checked.'),
 ('not_resolved','M4','Acknowledgment of reports/contracts not established.')]
}

visual = {
 'williamson-affidavit':[1,2], 'williamson-homeowner':[4], 'williamson-order':[2,10],
 'comal-rules':[6,7,11,12], 'hays-regulations':[19,20], 'hays-fees':[1],
 'tx-travis-county-source-1':[13,14], 'travis-nonres-checklist':[4],
 'brazoria-order':[7,12], 'grimes-2024-order':[4,5,7],
 'montgomery-local-order':[2,7,8], 'montgomery-food-contract':[1], 'montgomery-new-initial-contract':[1]
}
sha_alias = collections.defaultdict(list)
for row in manifest: sha_alias[row['sha256']].append(row['id'])
for row in manifest:
    p=ROOT/row['original_file']
    assert p.exists() and hashlib.sha256(p.read_bytes()).hexdigest()==row['sha256']
    row['duplicate_source_ids']=[x for x in sha_alias[row['sha256']] if x!=row['id']]
    row['representation']='derived browser excerpt' if 'browser excerpt' in row['title'].lower() else 'downloaded original'
    row['visual_reviewed_pdf_pages']=visual.get(row['id'],[])
    if p.suffix=='.pdf':
        pages=(ROOT/row['text_file']).read_text().split('\f')[:row['pages']]
        row['text_characters_by_page']=[len(x.strip()) for x in pages]
        low=[i+1 for i,x in enumerate(pages) if len(x.strip())<100]
        row['pages_with_little_or_no_text']=low
        row['extraction']='scanned PDF' if len(low)==row['pages'] else ('hybrid PDF' if low else 'PDF text layer')
        candidates=[ROOT/'extracted'/f"{sid}-ocr.txt" for sid in [row['id']]+row['duplicate_source_ids']]
        found=next((x for x in candidates if x.exists()),None)
        row['ocr_file']=str(found.relative_to(ROOT)) if found else None
        row['ocr_warning']='Derived OCR may contain errors. Use the original PDF for dates, thresholds, signatures and legal interpretation.' if found else None
    elif p.suffix=='.html':
        soup=BeautifulSoup(p.read_text(errors='replace'),'html.parser')
        for tag in soup(['script','style']):tag.decompose()
        out=ROOT/'extracted'/f"{row['id']}.txt"
        out.write_text(soup.get_text('\n',strip=True))
        row['text_file']=str(out.relative_to(ROOT))
    elif p.suffix=='.doc': row['text_file']='extracted/brazoria-fees.txt'
    if row['id'] in ('comal-bulverde','comal-fair-oaks','comal-garden-ridge','comal-schertz','comal-spring-branch'):
        row['review_note']='OCR text read; signature dates not relied upon without visual verification.'
    elif row['id'] in ('montgomery-food-contract','montgomery-new-initial-contract'):
        row['review_note']='Current linked scan archived and OCR available; compare with earlier contract, not a blanket renewal policy.'

(ROOT/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(ROOT/'findings.json').write_text(json.dumps(dict(researched_on='2026-10-06',baseline_head=baseline.get('head',baseline.get('commit')),scope='Eight authorities; no application/ruleset edits or authority contact',findings=findings),indent=2)+'\n')

def source_links(f):
    out=[]
    for ref in f['sources']:
        row=by_id[ref['id']]
        url=row['url'].replace(' ','%20')
        out.append(f"[{row['title']}](../{row['original_file']}) — {ref['location']}; [official source]({url})")
    return '\n'.join('- '+x for x in out)

all_dispositions=[]
for authority in baseline['authorities']:
    key=authority['authority']; short=key.removeprefix('tx-').removesuffix('-county')
    found=[f for f in findings if f['authority']==key]
    items=answers[short]; assert len(items)==len(authority['unresolved']), (short,len(items),len(authority['unresolved']))
    content=[f"# {short.title()} County research review",'','Research date: October 6, 2026. Public evidence review; authority confirmation and production acceptance remain pending. PDF page references below are physical pages in the saved file, not embedded court-record pagination.','']
    for f in found:
        content += [f"## {f['id']}: {f['title']}",'',f"Disposition: **{f['status']}**. Confidence in source reading: {f['confidence_in_source_reading']}. Actual authority acceptance: unconfirmed.",'',f['evidence'],'',f"Proposed action: {f['proposed_action']}",'']
        if f['sources']: content += [source_links(f),'']
    content+=['## Baseline unresolved items reassessed','','Numbers below refer to `profile.unresolved` array order in baseline.json; they are not the document’s separately numbered questions.','']
    for n,(question,answer) in enumerate(zip(authority['unresolved'],items),1):
        status,fid,note=answer
        content += [f"{n}. **{status}** — {note} (Evidence: {fid})",f"   Baseline: {question}",'']
        all_dispositions.append(dict(authority=key,baseline_unresolved_index=n,baseline_text=question,status=status,finding_ids=[fid],disposition=note))
    (ROOT/'authorities'/f'{key}.md').write_text('\n'.join(content))
(ROOT/'question-dispositions.json').write_text(json.dumps(all_dispositions,indent=2)+'\n')

stats=dict(source_records=len(manifest),unique_original_pdfs=len({x['sha256'] for x in manifest if x['original_file'].endswith('.pdf')}),
           unique_scanned_or_hybrid_pdfs=len({x['sha256'] for x in manifest if x.get('pages_with_little_or_no_text')}),
           unique_pdfs_with_ocr=len({x['sha256'] for x in manifest if x.get('ocr_file')}),
           baseline_unresolved_items=len(all_dispositions),findings=len(findings),
           disposition_counts=dict(collections.Counter(x['status'] for x in all_dispositions)))
(ROOT/'packet-stats.json').write_text(json.dumps(stats,indent=2)+'\n')
print(json.dumps(stats,indent=2))
