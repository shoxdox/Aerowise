# PARITY-MATRIX.md

Purpose: define the minimum capabilities required to run a septic maintenance operation.

Legend:
- P0 = needed before serious customer migration
- P1 = needed shortly after launch
- P2 = later / optional
- DIFFERENTIATOR = where we should be clearly better

| Capability | Priority | Our target |
|---|---:|---|
| Company/tenant | P0 | clean multi-tenant org model |
| Users/roles | P0 | owner/office/tech/read-only |
| Customers | P0 | strong CRM basics |
| Contacts | P0 | multiple contacts per customer/site |
| Sites | P0 | service location as first-class entity |
| System details | P0 | manufacturer/model/serial/permit/treatment/disposal |
| Contracts | P0 | annual, multi-year, commercial/residential |
| Service plans | P0 | reusable templates |
| Recurring service | P0 | interval + visits due + next due |
| Scheduling | P0 | calendar + assignment |
| Route view | P0 | map + manual order |
| Route optimization | P1 | optimization engine |
| Mobile inspection | P0 | extremely fast |
| Offline field mode | P0 | DIFFERENTIATOR |
| GPS/time capture | P0 | automatic |
| Photos | P0 | required-photo rules |
| Signatures | P0 | field + renewal |
| Inspection templates | P0 | configurable |
| Repairs/follow-up | P0 | inspection -> task/job/invoice |
| PDF report | P0 | internal + customer |
| County report | P0 | jurisdiction adapter |
| Filing tracking | P0 | state machine |
| Filing confirmation | P0/P1 | DIFFERENTIATOR |
| Exception inbox | P0 | DIFFERENTIATOR |
| Compliance ledger | P0 | DIFFERENTIATOR |
| Email | P0 | reports/invoices/renewals |
| SMS | P1 | reminders/on-the-way |
| Contract renewal | P0 | automated |
| E-sign | P0 | renewal flow |
| Customer portal | P0 | DIFFERENTIATOR |
| Invoices | P0 | normal SMB invoicing |
| Card payments | P0 | Stripe |
| ACH | P0 | Stripe |
| Autopay | P1 | renewals/contracts |
| Refunds | P1 | payment operations |
| Products/services | P0 | services/add-ons/parts |
| Basic taxes | P0 | simple mapping |
| QuickBooks OAuth | P1 | required for broad parity |
| QBO customer sync | P1 | |
| QBO item sync | P1 | |
| QBO invoice sync | P1 | |
| QBO payment sync | P1 | |
| QBO conflict center | P1 | DIFFERENTIATOR |
| CSV import | P0 | |
| XLSX import | P0 | |
| SAFE migration | P0/P1 | DIFFERENTIATOR |
| Intelligent field mapping | P0 | DIFFERENTIATOR |
| Customer report history | P0 | portal |
| Add-ons during renewal | P0 | revenue lever |
| Technician productivity | P1 | |
| Business dashboard | P0 | |
| Tags/notes | P0 | |
| Equipment | P1 | |
| Inventory | P2 | only if demanded |
| Vehicles | P2 | only if demanded |
| IoT integration | P2 | optional |
| Waste disposal facility registry | P2 | source independently |
| Septage manifests | P2 | expansion vertical |
| API/webhooks | P1/P2 | integration path |
| Multi-state compliance | P2 | architecture-ready from day one |

## Competitive philosophy

Parity gets us considered.

The differentiators get us chosen.

Primary win themes:

1. switching is easier
2. tech app is better
3. office touches fewer reports
4. renewals collect themselves
5. QuickBooks errors are visible
6. customers get a modern portal
