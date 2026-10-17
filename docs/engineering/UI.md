# UI.md

How the web app's screens are put together, so a new screen looks like the rest without new CSS. Everything here is in `apps/web/app/globals.css`; reach for these before writing a one-off rule.

## Tokens

Colors, type sizes and radii are custom properties on `:root`. The homepage (`components/marketing/marketing.css`) uses the same palette names.

- Text: `--ink` (`--text`), `--soft` (`--muted`). Surfaces: `--bg` (page), `--surface` (cards, tables), `--tint`.
- Lines: `--border` for dividers and card edges, `--control-border` for secondary buttons and filter chips, `--field-border` for inputs, selects and checkboxes (3:1 against white, so fields can be found).
- Brand: `--accent` (`--green`), `--accent-hover` (`--green-dark`), `--accent-tint` for selected things.
- Status pairs: `--warn-bg`/`--warn-text`, `--danger-bg`/`--error`, `--ok-bg`/`--ok-text`, `--info-bg`/`--info-text`, `--work-bg`/`--work-text`.
- Type: `--text-sm` 14px, `--text-base` 16px (body and every field), `--text-lg` 18px (h3), `--text-xl` 22px (h2), `--text-2xl` 28px (h1).

Paragraphs have no margins. Space comes from the container: `.stack` (a column, 12px gaps), `.row` (a wrapping row), `.grid`, `.columns`.

## Components

| Need | Use |
| --- | --- |
| The main action of an area | `<button>` with no class (filled green). One per area. |
| Other actions | `className="secondary"` (outlined). |
| Cancel, Retire, Deactivate, Void, Refund | `className="danger"` (red outline), or `"link danger"` for a text link. A `danger` button that is a form's `type="submit"` is filled red: the step that confirms. |
| Text that acts | `className="link"`. |
| A link that looks like a button | `<a className="button">` (add `secondary` as above). |
| List filters | `<div className="segmented" role="group" aria-label="Show">` around the buttons; mark each `aria-pressed` (true on the chosen one). Groups without `aria-pressed` fall back to the old marking: the chosen one has no class, the rest `secondary`. Never the primary style: that is for actions. |
| Sections of one record | `role="tablist"` with `role="tab"` buttons and `aria-selected`: underlined tabs. |
| A checkbox and its text | `<label className="check">` (inline) or `<label className="row">` (its own line). |
| Status | `<span className="badge ok|warn|danger|upcoming|work|cancelled|inactive">`. In a column it keeps its own width. |
| Money and counts in a table | `className="num"` on the `th` and `td`: right-aligned, even-width digits. |
| Label and value pairs | `<dl className="details">`; one column on a phone. Totals: `details totals`. |
| A list that must work on a phone | `<table className="stack">`, a `data-label` on each `td` but the first, and `className="actions"` on the cell with buttons. Under 640px each row becomes a card with the labels on the left and the actions full width at the bottom. Tables without `stack` scroll sideways inside their own box. |
| A clickable card | `className="card link-card"`. |

## The office shell

`app/(office)/layout.tsx` draws the header: the logo (to the inbox), the menu's five groups, and an account button with the signed-in person, their role and company, and Sign out. Where the links don't fit on one row the word beside the logo goes first, then the links fold behind Menu; the shell measures that, so adding a link needs no CSS. The menu folds again whenever the page changes. A link shows only to roles that can open its page. Technicians are sent to `/tech`. The tab is named after the menu item ("Schedule · Aerowise"); a detail page names it after its record with `usePageTitle`.

Sign-in pages read `?next=` only through `safeNext` (`lib/safe-next.ts`), which keeps it on this site.
