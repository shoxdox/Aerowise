# County evidence packet, 2026-10-06 (repository copy)

This folder is the October 6, 2026 original-source research pass on eight authorities: Williamson, Denton County, Comal, Hays, Travis, Brazoria, Grimes and Montgomery. It is research, not rules. Every finding in `findings.json` is marked `implemented: false` and `authority_confirmation: false`, and nothing here changes a ruleset. Corrections land through the W12 tasks in [the roadmap](../../../engineering/ROADMAP.md#w12-county-evidence-and-verification).

Start with [README.md](README.md), [CLAUDE-HANDOFF.md](CLAUDE-HANDOFF.md) and [remaining-questions.md](remaining-questions.md), then the eight files in `authorities/`.

## Where it came from

| Upload | Bytes | SHA-256 |
| --- | --- | --- |
| `Aerowise-County-Research-2026-10-06.zip` | 22,095,890 | `25f3b51a36f9113da48f9fcd9ff8fb5fce9939a1f724cb6f59d320e6412d07e1` |
| `Aerowise-Prior-Source-PDFs-2026-10-06.zip` | 28,467,449 | `9b3b1c2242d502af3b1b8fe25d6b52deb4c18517a72c5b7d732b061acccf1065` |

Both zips are in the Septic project's shared files, next to `Aerowise-Claude-Upload-Manifest-2026-10-06.json`, which lists the same sizes and hashes. The hashes above were checked against the uploads on 2026-10-06 before copying. The uploads themselves and the older exports (`Septic/pilot-build/county-research/` and `Septic/pilot-build/exports/`) are kept unchanged.

## What is in git and what is not

Every file in this folder is a byte-for-byte copy from the research zip, except this file and `prior-source-pdfs-download-manifest.json` (copied unchanged from the prior-source zip). The text files the packet produced are here: the markdown reviews, `source-manifest.json`, `findings.json`, `question-dispositions.json`, `baseline.json`, the download-attempt logs, the extracted text and OCR in `extracted/`, the small HTML pages and browser excerpts in `sources/`, the two build scripts, and the packet's inputs.

Left out of git:

- **The original PDFs and the one Word file in `sources/`** (37 PDFs and `brazoria-fees.doc`, about 27 MB). Links to them from the packet's markdown do not resolve in the repository; open them from the research zip. Each is listed below with its SHA-256, which also appears in `source-manifest.json`.
- **Page renders** (`rendered/`), which the packet's README says were never put in the zip.
- **`inputs/claude-conversation.txt`** (17,263 bytes, SHA-256 `73e849d1d292915f8ddb57c0d41a456a495f68f6cb8368bc09b2a8dd54be8dca`): a private planning chat, not evidence.
- **Yesterday's 40 PDFs** from the prior-source zip. Only its download manifest is copied here. Two of those PDFs matter for W12: the saved Denton County form `4eafacc1-Homeowners-Inspection-Form-PDF.pdf` (SHA-256 `7f32068bd5a8c0f201cb915fce9570eb461e8671badc2ad313f0ec499408983e`) and SJRA's signed order `c76e2b40-Order-Adopting-Rules-for-On-Site-Sewage-Facilities-Within-2075-feet-of-Lake-Conroe-Texas_121015.pdf..pdf` (SHA-256 `9d92200f395ce26e527a989ca4c68eb886d30c0bfc8f5d641a05ae8e2b46ad4a`).

## How to read it

- Public rules, implemented behavior and authority acceptance are three different things. A downloaded order is evidence of a rule; a passing test is evidence of behavior; only the authority or a provider's accepted filing shows acceptance. No profile becomes verified from this packet.
- The Denton entries marked `access_blocked` mean this pass could not fetch fresh copies (rate limiting and a browser challenge). They do not reverse the saved Denton originals from the prior pass or PR #76, which keeps Denton County's report channel separate from its contract channel.
- SJRA's `384053.4` is a repeating page footer, not an order number. Prefer the signed source above over the unsigned 2015/03 copy.
- OCR can misread numbers, dates and handwriting. Check the original page image before relying on a decisive value.

## Original files not in git

| File (not in git) | Authority | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `sources/brazoria-fees.doc` | tx-brazoria-county | 51,200 | `152df2d9e992891d27f9fc752e51a2a0c42d7c3d7bed8fa3658d6178ec172d5f` |
| `sources/brazoria-order.pdf` | tx-brazoria-county | 764,703 | `8eef650917061432ac0e2a40a5889f1609ff00e9db3e0d757f2eda236cfb6b7e` |
| `sources/tx-brazoria-county-source-4.pdf` | tx-brazoria-county | 1,742,145 | `9f6e84b4c0935d180eeb26aaf1ea7425da86630205a94a8a5ab7bd61b51b1dfd` |
| `sources/comal-bulverde.pdf` | tx-comal-county | 154,864 | `c06972a8ceb15b4c1f88ca12ed6501c498a95e91e1e67a940acadbfc1032ed0d` |
| `sources/comal-fair-oaks.pdf` | tx-comal-county | 160,332 | `bf7e05f4e69cd9db1ee1c4ff4a6d737c6692a2248cd4f260339af31100460b0f` |
| `sources/comal-fees.pdf` | tx-comal-county | 460,630 | `ea1d9262b4068c582f1ded788ef4b6e5a8a657fc0ade6c1e5f3b2c4187f4f8f1` |
| `sources/comal-garden-ridge.pdf` | tx-comal-county | 147,194 | `7902781162db58ef7258095dabde0c1885ce14e304414d8cf43647c93c957a53` |
| `sources/comal-rules.pdf` | tx-comal-county | 1,879,875 | `5de06b5bd5c0a3d0a45793b1b929098aa081baccabedd744cb572be2ff9d978c` |
| `sources/comal-schertz.pdf` | tx-comal-county | 159,181 | `fae4c9e939f64025a5cb1deaaa75245e6f92171123b81c7001aef46d8de72297` |
| `sources/comal-spring-branch.pdf` | tx-comal-county | 233,303 | `6369d41805c98c910e9ae8edf6d5e4f993f6c6d2e82bf6bfa62447e3d6498a40` |
| `sources/tx-comal-county-source-3.pdf` | tx-comal-county | 1,879,875 | `5de06b5bd5c0a3d0a45793b1b929098aa081baccabedd744cb572be2ff9d978c` |
| `sources/tx-comal-county-source-4.pdf` | tx-comal-county | 460,630 | `ea1d9262b4068c582f1ded788ef4b6e5a8a657fc0ade6c1e5f3b2c4187f4f8f1` |
| `sources/grimes-2024-order.pdf` | tx-grimes-county | 489,056 | `1a1daf8f24f613346f1d1da4b6677506855f9dae707d16ba0b99c38b60cb9865` |
| `sources/grimes-tceq-notice.pdf` | tx-grimes-county | 120,303 | `00e4cccee506daa852ab72da5f2e36360bd55896a47ea0dbf86886227aaacfcc` |
| `sources/tx-grimes-county-source-3.pdf` | tx-grimes-county | 103,346 | `7a33858e2425817223dca79748378b75a6f752cd4aa2cd45ab4de136c21088b8` |
| `sources/tx-grimes-county-source-4.pdf` | tx-grimes-county | 238,122 | `9d4be5d0036e61a0f892f1811367241b4bda08a7cd281273c5b9fa1e1a80554a` |
| `sources/hays-affidavit.pdf` | tx-hays-county | 118,730 | `3ef4485bbc758e999aa14228cc4f98e56f0ed3d15cc23c6fe40582db92cc3df8` |
| `sources/hays-fees.pdf` | tx-hays-county | 221,979 | `5377bced44480bd16a762cfcb28e0aa0b8aa27bd6faf6921838bf80b56658334` |
| `sources/hays-regulations.pdf` | tx-hays-county | 211,164 | `dc45dc3bc3c101d3fbfdb60d6e559278d523676037ec5196aa86f769ec8194fe` |
| `sources/montgomery-fees.pdf` | tx-montgomery-county | 115,221 | `3dcbc53c9a1899ec8acadc2c6725238fbf27f8d5cda32cf7f8b1bf20b23afe00` |
| `sources/montgomery-food-contract.pdf` | tx-montgomery-county | 35,494 | `6d88300de95d09f3b76f1c1b01eeade701277cca1da948fd5d41df6b5e28b295` |
| `sources/montgomery-local-order.pdf` | tx-montgomery-county | 3,549,592 | `6ee5de5b6118a38b38b1d5c111c65be9e41ef39d57fb44d8a28b38de15aad6fe` |
| `sources/montgomery-new-initial-contract.pdf` | tx-montgomery-county | 31,098 | `57cc6421d9f344badb4fc9c35a1fea9288bd97664a01038492f600a2cd3c77c0` |
| `sources/tx-montgomery-county-source-1.pdf` | tx-montgomery-county | 28,420 | `6e6636f390e56a5282b8c40adc17a763b9363590359449579a175bda3a03fd20` |
| `sources/tx-montgomery-county-source-2.pdf` | tx-montgomery-county | 1,024,310 | `d6212d7a66e844b04a869deb613369c8341db26ddf4736be337532bba9f7b9b5` |
| `sources/tx-montgomery-county-source-3.pdf` | tx-montgomery-county | 495,397 | `1068042d3a7f8dfaaa251ceba814574bfaceaad457735d9d149c7bbd5bf8bc55` |
| `sources/tx-montgomery-county-source-4.pdf` | tx-montgomery-county | 50,880 | `6243891da0f3457ff65c371daae1a1e409879ea19362d8ddf05d44c60e77e891` |
| `sources/lcra-order.pdf` | tx-travis-county | 808,369 | `e4d1ce3bdc863410674eef11e17b2545e2a51f9cdeec19808802a9fd3769d185` |
| `sources/travis-nonres-checklist.pdf` | tx-travis-county | 658,910 | `282db5b2c02324f021aae7439269fc38d800b1eb14fa04c23f19186a8ed6b9a4` |
| `sources/tx-travis-county-source-1.pdf` | tx-travis-county | 260,970 | `09fe69d50c2c478786329c0cde0921d4ed0a22f2b0e4dc21efb91863b6401651` |
| `sources/tx-travis-county-source-2.pdf` | tx-travis-county | 11,313 | `bdb332a877e0ebb5fd7b8de4665454dd8a78a5c618bce72d42a17a309fd33b2a` |
| `sources/tx-williamson-county-source-2.pdf` | tx-williamson-county | 214,317 | `4e4ddb6b2e25eda626ca040518ec9cc7fe7e3a55fd7414b6d7b4baecbf5221c9` |
| `sources/williamson-affidavit.pdf` | tx-williamson-county | 1,135,208 | `13f0f7718e2edd21bea218cdde14fc5f40e5a9ce7d4e1a98191bc812ba2adc90` |
| `sources/williamson-care.pdf` | tx-williamson-county | 1,212,470 | `3815cdb9f203a0e54f4b75053ea4c70ef11ebce262623fbdfb30593bb4b4bd33` |
| `sources/williamson-fees.pdf` | tx-williamson-county | 2,301,200 | `bfc3b0287f30137ca3f0617743d5deb863a7dd48d5857739461d31b61ef39932` |
| `sources/williamson-guide.pdf` | tx-williamson-county | 2,416,257 | `0fd0bd0654c91038bf088f3ca337db5a53c07c8303a68c58bf3b4f63c4072878` |
| `sources/williamson-homeowner.pdf` | tx-williamson-county | 1,604,229 | `5cc51756237bcfe51efd0dcce65f370cc93e3cb594639ad0554de6d14bcbe18d` |
| `sources/williamson-order.pdf` | tx-williamson-county | 1,752,405 | `81c1e2da25c043c4564d729b67883e45e1e0f5f74411386a6c336d1b9e67e032` |
