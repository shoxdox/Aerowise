# Fort Bend County (TX) — Maintenance Provider Inspection Bulk Upload: Field Specification

Research date: 2026-10-09
Scope: Fort Bend County Environmental Health (FBCEH) maintenance-provider inspection bulk upload on the MyHD portal (myhealthdepartment.com/fbceh), plus the related contract-filing rules. Web-only research from primary county sources. Downloaded copies and extracted text are in the session scratchpad (`scratchpad/fortbend/`), not in the repo.

Legend used below:
- **[PDF]** = document downloaded and text extracted with `pdftotext` (hash given in section 1).
- **[HTML]** = county web page fetched (raw HTML downloaded with curl and/or read via WebFetch).
- **[SNIPPET]** = search-engine snippet only; not independently fetched. Treated as unverified.

---

## 1. Sources

| # | URL | Title (as the county writes it) | Stated date / version | How obtained | SHA-256 |
|---|-----|--------------------------------|-----------------------|--------------|---------|
| S1 | https://fortbendcountytx.gov/sites/default/files/document-central/Maintenance-Provider-Inspection-Bulk-Upload-Instructions-04-04-25.pdf | "Maintenance Contract Submittal / Bulk Upload" (letterhead: Health & Human Services, Environmental Health, Fort Bend County, Texas; 4520 Reading Road, Suite A-800, Rosenberg TX 77471; Office 281-342-7469, Fax 281-342-5572). The web filename calls it "Maintenance Provider Inspection Bulk Upload Instructions 04 04 25". 2 pages. | Filename date 04-04-25; PDF metadata CreationDate 2025-04-04 13:02 CDT, Author "Annette Gonzalez", Acrobat PDFMaker 25 for Word. No version number inside the document. | [PDF] curl, HTTP 200, 202,892 bytes | `ac43da357edbd87133daca61a57b69ab3b17af6ee15662e54cfbeae7fdfbfa0d` |
| S2 | https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/environmental-health-documents/forms-library/OSSF-Customer-Portal---How-To-Guide.pdf | "OSSF Customer Portal - How To Guide" (first heading inside: "Logging into MyHD Customer Portal"). 20 pages. | No date printed in the text layer; PDF metadata CreationDate 2025-08-06 10:23 CDT, Author "Hernandez, Crystal". | [PDF] curl, HTTP 200, 2,790,867 bytes | `0eb7459dbd6007ef0d73aecdc46e58ac2776fb06bfe7664af34f5b407c587aa4` |
| S3 | https://www.fortbendcountytx.gov/sites/default/files/document-central/document-central/environmental-health-documents/forms-library/site-sewage-facility-packet/OSSF-Customer-Portal---How-To-Guide-%5BPDF%5D---Spanish.pdf | Spanish version of the how-to guide ("Iniciando sesiόn en el Portal de Clientes de MyHD"). 6 pages; covers login, contract submission and payment only — it does NOT contain the inspection / data-wizard section. | Printed "September 2025"; metadata CreationDate 2025-09-05. | [PDF] curl, HTTP 200, 634,506 bytes | `269d705b3efee62eaa7b195470a1d6c6a8fa66dfd072ac4d34631e020a219c90` |
| S4 | https://www.fortbendcountytx.gov/government/departments/health-and-human-services/environmental-health/aerobic-maintenance-information | "AEROBIC MAINTENANCE INFORMATION" (sections: Maintenance Contracts; What does the Maintenance Provider Do?; What to Expect at a Typical Service Visit; Chlorine Disinfectant; Aerobic Systems Do's and Don'ts; Warning Signs; Finding A Maintenance Provider; Annual Maintenance Contract Renewal Fee) | Undated page. Raw HTML contains a **commented-out** (not rendered) block headed "IMPORTANT / OSSF UPDATE / 05-02-25" referencing two embedded documents, "OSSF UPDATE FOR SAFE USERS [PDF]" and "FIELDBASE ON-SITE SOFTWARE UPDATE [PDF]" (Drupal media UUIDs f55b3e23-055b-48b7-a1c0-ed9f296921c3 and 24ac8181-9d51-42f0-8c50-289fcebca8c2). Both media endpoints return 404; the PDFs could not be retrieved. | [HTML] curl + WebFetch | n/a |
| S5 | https://www.fortbendcountytx.gov/government/departments/health-and-human-services/environmental-health/annual-maintenance-contract-renewal-fee | "Responsibilities of Aerobic OSSF System Owners" (page slug "annual-maintenance-contract-renewal-fee") | Undated ("This letter is a courtesy reminder ...") | [HTML] curl + WebFetch | n/a |
| S6 | https://www.fortbendcountytx.gov/government/departments/health-and-human-services/environmental-health/permitting/permit-fees | "Permit Fees" (Environmental Health fee schedule) | Page states "All fees are current as of 5/26/2023" | [HTML] curl + WebFetch | n/a |
| S7 | https://agendalink.fortbendcountytx.gov/docs/2023/CCTR/20230523_3776/56917_OSSF_Fees_Schedule.pdf | Commissioners' Court letter from Michael R Schaffer, Division Manager – Environmental Health, requesting OSSF fee changes "effective June 1, 2023" | Dated 05/23/23 | [PDF] curl, HTTP 200, 335,341 bytes | `175ad5fb3ac3b8e89f229f60a06fb6f5ddbef747d046de98fb48b74e8aaf2e03` |
| S8 | https://www.fortbendcountyTX.gov/sites/default/files/document-central/document-central/environmental-health-documents/forms-library/additional-site-sewage-facility-information/OnSiteSewageFacilityMainte.pdf | "MAINTENANCE REQUIREMENTS" / "REQUIRED TESTING AND REPORTING" table / "Annual Maintenance Contract Renewal Fee" (PDF title metadata "OSSF REQUIREMENTS") | Printed "December, 2009"; metadata CreationDate 2009-12-18 | [PDF] curl, HTTP 200, 29,714 bytes | `bf8edffe1fc61463cea665b9fa34806bfe648c1f8f280410cc112518c028eb99` |
| S9 | https://www.fortbendcountytx.gov/government/departments/environmental-health/maintenance-contracts | "Maintenance Contracts" (older URL path; same content as the S4 section) | Undated | [HTML] WebFetch | n/a |
| S10 | https://www.fortbendcountytx.gov/government/departments/environmental-health/what-does-the-maintenance-company-do | "What does the maintenance company do" (older URL path; same content as the S4 section) | Undated | [HTML] WebFetch | n/a |
| S11 | https://myhealthdepartment.com/fbceh | "Fort Bend County Environmental Health | My Health Department" landing page (links: /fbceh/login, /fbceh/register) | Undated | [HTML] WebFetch | n/a |
| S12 | https://myhealthdepartment.com/fbceh/register | MyHD registration form (fields: Company Name, First Name, Last Name, Email Address, Cell Number, Password, CAPTCHA) | Undated | [HTML] WebFetch | n/a |
| S13 | https://www.fortbendcountytx.gov/government/departments/health-and-human-services/environmental-health/on-site-sewage-facility-ossf-program | "On-Site Sewage Facility (OSSF) Program" | Undated | [HTML] WebFetch — contains nothing about provider uploads | n/a |

Search-engine only (not fetched): Google/Bing snippets for the queries used reproduced the S1 field list and S2 wizard text; no snippet contained anything not present in the fetched documents. The prior researcher's claims of "27-field CSV/TSV/TXT schema", "name list", "permit must match exactly", "one PDF at a time", and "fee per contract year" are all confirmed by S1/S2/S5 below. Nothing in this report rests on a snippet alone.

Not found anywhere public: a MyHD/FBCEH document stating encoding, header-row handling, quoting rules, row limits, or the error-report format for the data wizard. See section 6.

---

## 2. Column specification (from S1, verbatim order)

S1 page 1 gives the header order as a single comma-separated line (line breaks in the PDF are layout wraps, reproduced here as one line):

```
Inspection Date,Inspection Type,Service Company,Maintenance Technician Name,Aerators,Alarms,Filters,Irrigation Pumps,Recirculation Pumps,Chlorine Supply,Electrical Circuits/Control Box,Distribution Systems,Sprayfield Vegetation/Seeding (If Applicable),Float,Disinfection Device,Tank Lid,Needs Pumping,Cl2,Test Method,BOD (Grab),Test Method,TSS (Grab),Test Method,Fecal Coliform,Test Method,General comments or recommendations,OSSF Permit Number
```

That is **27 columns**. S1 page 2 ("Field Label / Options/Formats") restates them with allowed values; on page 2 the four "Test Method" columns are disambiguated as "Test Method Cl2", "Test Method BOD", "Test Method TSS", "Test Method Fecal Coliform", and the control-box label is printed "Electrical Circuits/ Control Box" (space after the slash) whereas the page-1 header line wraps at "Electrical Circuits/" + newline + "Control Box" (so whether a space belongs after the slash is ambiguous in the PDF — see Unknowns).

Required-ness: S1 never marks any column as required or optional. It says only: "Each field must have the correct option and/or the field needs formatted correctly" and "Make sure that any blank entries are still separated by a comma. Example if the field is blank then you would supply ",,"." So the only hard rules are (a) 27 positions always present, and (b) if a value is present it must be one of the listed options / in the listed format. The "Required?" column below therefore reports what the document implies, not an explicit county statement.

| Pos | Exact header text (S1 p.1) | Page-2 "Field Label" (S1 p.2) | Allowed values / format, quoted from S1 p.2 "Options/Formats" | Required? | Matching rule / notes |
|----|----|----|----|----|----|
| 1 | `Inspection Date` | Inspection Date | `xx/xx/xxxx` | Implied required (identifies the inspection). Not stated. | Format is a 10-character slash date. S1 does not say MM/DD/YYYY vs DD/MM/YYYY; US locale and the "xx/xx/xxxx" mask imply MM/DD/YYYY with zero-padded 2-digit month/day and 4-digit year. |
| 2 | `Inspection Type` | Inspection Type | `Customer Request,Pumping Inspection,Repair,Scheduled Inspection` | Implied required. Not stated. | Enumerated; one of the four literal strings. Routine 4-month visits map to "Scheduled Inspection". |
| 3 | `Service Company` | Service Company | "This must match our system. Please inquire to the exact name." | Implied required. Not stated. | Must equal the company name as it exists in FBCEH's MyHD system. The county does not publish the list in S1; the how-to guide (S2) shows it as a dropdown of service companies in the portal ("a list of service companies will show up to choose from. They are working on getting them alphabetical"). Obtain the exact string from the county (281-342-7469) or read it from the portal dropdown. |
| 4 | `Maintenance Technician Name` | Maintenance Technician Name | `Open Text` | Not stated. | Free text. S2 shows that the contract form has a "Maintenance Provider Name" dropdown, but for the inspection bulk upload S1 says open text, so no list match is documented. |
| 5 | `Aerators` | Aerators | `Operational,Inoperative` | Not stated (blank allowed via ",,"). | One of the two literal strings. |
| 6 | `Alarms` | Alarms | `Operational,Inoperative` | Not stated. | Same. |
| 7 | `Filters` | Filters | `Operational,Inoperative` | Not stated. | Same. |
| 8 | `Irrigation Pumps` | Irrigation Pumps | `Operational,Inoperative` | Not stated. | Same. |
| 9 | `Recirculation Pumps` | Recirculation Pumps | `Operational,Inoperative` | Not stated. | Same. |
| 10 | `Chlorine Supply` | Chlorine Supply | `Operational,Inoperative` | Not stated. | Same. |
| 11 | `Electrical Circuits/Control Box` (wraps at the slash in the PDF) | Electrical Circuits/ Control Box | `Operational,Inoperative` | Not stated. | Same. Header spacing after "/" ambiguous (see Unknowns). |
| 12 | `Distribution Systems` | Distribution Systems | `Operational,Inoperative` | Not stated. | Same. |
| 13 | `Sprayfield Vegetation/Seeding (If Applicable)` | Sprayfield Vegetation/Seeding (If Applicable) | `Operational,Inoperative` | Explicitly conditional ("If Applicable"); leave blank when N/A. | Same. S1 gives no "N/A" literal; the only documented way to express not-applicable is a blank field. |
| 14 | `Float` | Float | `Operational,Inoperative` | Not stated. | Same. |
| 15 | `Disinfection Device` | Disinfection Device | `Operational,Inoperative` | Not stated. | Same. |
| 16 | `Tank Lid` | Tank Lid | `Operational,Inoperative` | Not stated. | Same. |
| 17 | `Needs Pumping` | Needs Pumping | `Yes,No` | Not stated. | Literal "Yes" / "No" (not Y/N, not true/false). |
| 18 | `Cl2` | Cl2 | `Decimal` | Not stated. | Chlorine residual. S1 gives no units; county pages (S4, S8) express chlorine residual in mg/l ("at least 0.1 mg/l"), so mg/L is the implied unit. No precision stated. |
| 19 | `Test Method` (1st) | Test Method Cl2 | `Text` | Not stated. | Free text describing the Cl2 test method. No enumerated list. |
| 20 | `BOD (Grab)` | BOD (Grab) | `Decimal` | Not stated. | Biochemical Oxygen Demand grab sample. No units stated; S8 table expresses BOD5/TSS limits in mg/l ("Not to Exceed 65mg/1"). |
| 21 | `Test Method` (2nd) | Test Method BOD | `Text` | Not stated. | Free text. |
| 22 | `TSS (Grab)` | TSS (Grab) | `Decimal` | Not stated. | Total Suspended Solids grab sample. Units implied mg/l (S8). |
| 23 | `Test Method` (3rd) | Test Method TSS | `Text` | Not stated. | Free text. |
| 24 | `Fecal Coliform` | Fecal Coliform | `Decimal` | Not stated. | No units stated; S8 expresses the limit as "200 MPN / 100 ml (CFU / 100 ml)". |
| 25 | `Test Method` (4th) | Test Method Fecal Coliform | `Text` | Not stated. | Free text. |
| 26 | `General comments or recommendations` | General comments or recommendations | `Text` | Not stated. | Free text. S1 gives no rule for commas inside this field; see Unknowns (quoting). |
| 27 | `OSSF Permit Number` | OSSF Permit Number | "Your permit number. Must match exactly." | Implied required (this is the record key). | Must equal the FBCEH OSSF permit number string exactly as held in MyHD. S2 shows permit lookup/verification ("type in your permit number. When you see it pop up, click on the blue box that says Verify ... MAKE SURE THE STATUS SAYS ACTIVE") for contracts; the bulk inspection upload has no interactive verify step, hence "must match exactly". S1 does not document the permit-number format (prefix, digits, separators). |

Column-count check: 4 identity fields + 12 component flags (positions 5–16) + Needs Pumping + 4 analyte/method pairs (8 columns) + comments + permit = 27. This matches the prior researcher's count.

Things S1 does NOT contain (do not invent them): no column for property address, owner name, contract number, chlorine type, pump-out date, technician license number, or "N/A"/"Not Applicable" option; no numeric ranges; no maximum text lengths.

---

## 3. File-level rules

Everything below is quoted or paraphrased from S1 (bulk-upload instructions) and S2 (portal how-to guide). Where the documents are silent, that is stated.

**Delimiter.** S1: "you will need to be sure to have the appropriate data fields separated with a comma "," in a specific order." S1 only describes comma separation. S2 (Launch Data Wizard section): "Here you can enter multiple inspections manually at once, or upload the data from a .csv file, .tsv file, or a .txt file". So the portal accepts .csv, .tsv and .txt extensions; the county's own instructions describe only the comma layout. Whether a .tsv is parsed with tabs or must still be comma-separated is not documented.

**Blank fields.** S1: "Make sure that any blank entries are still separated by a comma. Example if the field is blank then you would supply ",,"." Every row therefore has exactly 27 positions (26 commas) regardless of missing data.

**Header row.** Not stated in S1 or S2. S1 presents the header line as the list of fields "in a specific order"; it does not say whether the first row of the file should contain those headers or only data. Unknown — see section 6.

**Encoding / quoting / line endings.** Not stated anywhere. S1 gives no escaping rule for commas or quotes inside "General comments or recommendations" or technician names.

**One row per inspection.** Implied by S1 ("upload multiple maintenance inspections ... data fields ... in a specific order") and by S2 (wizard "enter multiple inspections manually at once, or upload the data from a ... file"). Not stated in those words.

**File size / row limits.** Not stated in S1 or S2.

**Validation and error reporting.** S1: "Each field must have the correct option and/or the field needs formatted correctly." and "Should you have any questions related these instructions or need to confirm that what you are sending is correct, please contact our office at 281-342-7469." No document describes how the wizard reports a rejected row or file, or whether a partial file is accepted.

**Whether a PDF must also be attached to inspections.** No. S2 (Enter Records Directly): "YOU DO NOT HAVE TO UPLOAD A COPY OF THE INSPECTION, but you do have the option too. We will go by what you enter." (Contrast with contracts, where a PDF upload is required — section 4.)

**Portal path for inspections.** S2 step 5: log in > "On- Site Sewage Facility" > "Maintenance Contractor OSSF Inspections" > "Submit a New OSSF Maintenance Provider Inspections" > choose "Enter Records Directly" ("good when you only have a couple of inspections to enter") or "Launch Data wizard" ("preferred when have bulk of inspections to enter"). In the wizard: "If you upload data from a file, click on the Upload data from a file button, choose a file, then upload."

**Draft / review / submit flow (direct entry).** S2: after entering, "Save and Add Another inspection, Save and Review, or Save Draft and return to it later." From review you can "add another report ... Edit the inspection, and Delete the inspection. At this time your inspection HAS NOT been submitted yet." Then "Click Submit" > confirmation dialog > "Press Ok". Submitted items appear under "Past Submissions". S2 does not describe whether the wizard-uploaded rows pass through the same review screen.

**"Loading…" warning (quoted).** S2: "Press Ok- You should get a screen that says the inspection was successfully submitted. If not, it will continue to say Loading…. If this happens, do not resubmit. We did get the inspection."

**One login per company (quoted).** S2 step 1: "You will need to set an account. (it is best to have one log in per company. To avoid duplicate submissions, and invoices.)" The Spanish guide (S3) phrases it as "es major tener un acceso por persona/empresa para evitar envios duplicados y facturas" (one access per person/company). This is advice, not an enforced rule in the documents. The MyHD registration form (S12) collects Company Name, First Name, Last Name, Email Address, Cell Number, Password and a CAPTCHA.

**Browser.** S11 landing page recommends Microsoft Edge, Google Chrome, or Firefox.

**Fee for inspection submissions.** None mentioned anywhere. Fees attach to contracts only (section 4).

---

## 4. Contract filing rules

**Channel.** S5: "Contracts will not be accepted in the office. Contracts must be submitted online (https://myhealthdepartment.com/fbceh)." and "Fees will be accepted online or in the office and will not be accepted by mail." S4/S8: "Contracts and fee will not be accepted by fax or mail."

**Portal path.** S2 step 4: "On-Site Sewage Facility" > "Maintenance Contract Yearly Fee" > "Submit a New OSSF Maintenance Contract". Form fields per S2: OSSF Permit (type permit number, click "Verify"; "If your permit does not show, or if it shows multiple permits you will have to scroll to find it OR search it by address. (MAKE SURE THE STATUS SAYS ACTIVE)"); Service Company (dropdown); Maintenance Provider Name (dropdown); Start Date and End Date of the contract; "Food Establishment? – If YES is chosen, then this will notify the reviewers that BOD/TSS testing is required."; "Number of Years for this Contract- the is required and will determine how much is charged to your invoice."; Comments; Upload.

**Document and one-at-a-time rule (quoted).** S2: "Upload- A copy of the maintenance contract is REQUIRED to be uploaded ONLY ONE MAINTENANCE CONTRACT AT A TIME." and "You will save a pdf file to your computer>Click on Choose File>choose the pdf file". "Contract will not be processed if Contract and/or payment isn't uploaded or made." There is no bulk upload for contracts.

**Contract content requirements.** S5: "The current OSSF permit number must be identified on all contracts as well as signatures from both the maintenance provider and the owner." S4 lists minimum contract contents (items covered; response time to owner complaints; name of the manufacturer-certified individual; frequency of routine maintenance and of required testing and reporting; who maintains the disinfection unit).

**Fee per contract year.** S6 (fee schedule, "current as of 5/26/2023"): "Aerobic system annual maintenance fee | Contracts are submitted | $50.00 | Annually - Each System". S7 (Commissioners' Court letter 05/23/23) shows this rose from $20.00 (in effect since 1/1/2010) to $50.00 effective June 1, 2023. S5: "Contracts for more than one year {Example: 2+} must pay the annual fee for each year of the contract." S2 confirms the portal computes the invoice from "Number of Years for this Contract".

**Related fees (S6).** "Re-Instatement Fee | Of Annual Maintenance Contract with same provider in the same contract period | $25.00"; "Late Fee | $75.00". S5: "If this is submitted late then there will be a late fee associated the contract renewal fee." and "Contracts will not be accepted without the renewal fee (including any late fees) and must be paid at the time of submittal." "There are no credits, refunds or substitutions for this fee. Contracts that are cancelled will require a new contract and another fee to be paid at the time of submittal." "Any renewing contract without the fee(s) will be denied and returned."

**Payment mechanics.** S2 "HOW TO MAKE AN ONLINE PAYMENT": after submitting, confirm > "Redirecting to Payment" > cart > "Pay Cart" > redirected to "ACI Payments, Inc" > confirmation email from ACI. Invoices can also be paid later from the account ("Click to Make a payment", search invoice number, Add to Cart). For OSSF permit applications (not contracts) S2 states a 5-business-day payment window; no equivalent window is stated for contracts.

**Renewal timing.** S4: "New aerobic systems come with a two (2) year manufacturer service contract included in the purchase price." "Subsequent contracts must be renewed 30 days prior to expiration of the current contract." S5 quotes 30 TAC 285.7(d)(2) and adds: "Failing to turn in a contract 30 days before the contract expires will result in a Notice of Violation". S5 also: filing is the owner's responsibility; "There are maintenance contractors that will file on your behalf but is not required by State of Local laws or regulations. If you choose to have a maintenance contractor submit on your behalf and is late, the responsibility still lies on the owner".

**Initial two-year contracts.** S4/S8 say the renewal fee applies "After expiration of the initial two (2) year maintenance contract". The documents do not say whether the initial contract is filed through the same portal form or with the permit application.

---

## 5. Fort Bend-specific inspection / maintenance rules (sourced)

- **Frequency, residential.** S4: "Fort Bend County requires a property owner to contract with a certified maintenance provider to perform the required maintenance testing and reporting every 4 months." S4/S8: provider must "Submit a report to the permitting authority and owner at least once every four months. All test results and maintenance reports shall be sent to the permitting authority within 14 days after the test is performed."
- **Frequency, food establishments.** S4: "All establishments holding a Fort Bend County Food Establishment Permit and receiving secondary treatment shall be visited and maintained monthly by a certified maintenance provider. A chlorine residual or fecal coliform test shall be made at each site visit where disinfection is required. One BOD and TSS Grab Sample test shall be conducted per year". S8 (2009) table: "Fort Bend County Facilities holding a Retail Food Permit | Once a month | Total Chlorine Residual or Fecal Coliform at Each Required Visit; One BOD5 and TSS Grab Sample/year | ... BOD5 and TSS Grab Samples Not to Exceed 65mg/1". S2 contract form: "Food Establishment? – If YES is chosen, then this will notify the reviewers that BOD/TSS testing is required."
- **Minimum acceptable results (S8 table).** "0.1 mg/1 Residual in Pump Tank or Fecal Coliform Not to Exceed 200 MPN / 100 ml (CFU / 100 ml)". S4: owner must "maintain chlorine residual of at least 0.1 mg/l at all times of operation."
- **Self-maintenance prohibition.** S4: "The Fort Bend County Local Order for On-Site Sewage Facilities prohibits property owners/homeowners from performing this task on their own property, unless the property owner/homeowner is a certified maintenance provider for that aerobic treatment unit and holds the required State licenses." S5: "per FBC regulations, All contracted maintenance of an on-site sewage disposal system using aerobic treatment shall be conducted by a certified maintenance provider. There shall be no homeowner/property owner maintenance ... unless the property owner/homeowner is a certified maintenance provider for that aerobic treatment unit." (The Local Order PDF itself was not located online.)
- **Per-visit duties (S4).** Inspect components and note whether each is working; install and punch/mark a maintenance tag; test for chlorine residual, BOD and TSS as required; respond to owner complaints. These duties map directly onto the 12 component flags + analyte columns in S1.
- **Enforcement.** S4: "Failure to obtain a maintenance contract will result in a Class C misdemeanor charge filed with the Justice of the Peace Court."
- **Provider listing.** S5: FBCEH "does have courtesy listing of maintenance providers and can be sent upon request by contacting our office at EH-General@fortbendcountytx.gov." (This is the likely source of the exact "Service Company" strings.)
- **Third-party software notice (unverified).** The aerobic page's hidden/commented HTML (S4, dated 05-02-25) addressed "Maintenance Providers that use the SAFE software" and "the Frontier On-Site software" with two PDFs ("OSSF UPDATE FOR SAFE USERS", "FIELDBASE ON-SITE SOFTWARE UPDATE"). The block is not rendered and the PDFs are not retrievable (404). Content unknown; it may describe vendor-specific export mappings to this same 27-column format.
- **Forms.** No county-prescribed inspection form was found. S1 is the only inspection data spec; S2 says the county "will go by what you enter" in the portal.

---

## 6. Unknowns (need a call to 281-342-7469 / EH-General@fortbendcountytx.gov or a test account)

1. **Header row**: must the file's first line be the 27 headers, must it be omitted, or is either accepted?
2. **Exact header spelling** if a header row is used: "Electrical Circuits/Control Box" vs "Electrical Circuits/ Control Box"; whether the four "Test Method" columns are identified positionally (page 1) or by the page-2 labels ("Test Method Cl2" etc.).
3. **Delimiter for .tsv/.txt**: does the wizard auto-detect tabs, or must every file type be comma-separated as S1 says?
4. **Quoting/escaping**: how to carry a comma, quote or newline inside "General comments or recommendations" or a technician name (RFC-4180 double quotes? not allowed?).
5. **Encoding and line endings** (UTF-8 vs Windows-1252; CRLF vs LF; BOM tolerance).
6. **Date format** confirmation (MM/DD/YYYY assumed from "xx/xx/xxxx"); whether single-digit months/days are accepted.
7. **Case sensitivity** of enumerations ("Operational", "Yes", "Scheduled Inspection") and of the Service Company / permit matches.
8. **The exact Service Company string** for the submitting company as stored in MyHD (S1: "Please inquire to the exact name").
9. **OSSF Permit Number format** (digits only? prefix? leading zeros?) and behaviour when a permit is not ACTIVE.
10. **Blank vs N/A semantics** for the 12 component flags: does blank mean "not inspected", "not applicable", or is it rejected for some columns? Which columns, if any, are truly required?
11. **Units and precision** for Cl2, BOD, TSS, Fecal Coliform (mg/L assumed; MPN/100 mL for fecal). Whether "<0.1" style non-numeric values are rejected (S1 says "Decimal").
12. **Row / file-size limits** and whether a file with one bad row is rejected whole or partially accepted.
13. **Error reporting**: what the wizard shows on validation failure, and whether rejected rows can be downloaded.
14. **Duplicate handling**: what happens if the same permit + date is uploaded twice (relevant to the "Loading… do not resubmit" guidance).
15. **Whether wizard uploads go through the Save and Review screen** before final Submit, or submit immediately.
16. **Optional PDF attachment with bulk uploads**: S2 says a copy is optional for direct entry; whether the wizard allows attachments per row is not described.
17. **Contents of the 05-02-25 "SAFE users" and "Fieldbase" update PDFs** (not retrievable).
18. **Initial two-year contract filing**: whether it goes through the same portal form and whether the $50/year fee applies to it (county text says the fee applies after the initial contract expires).
19. **Account model**: whether MyHD enforces one account per company or merely recommends it; whether technicians can have sub-logins.
