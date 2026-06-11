# Taylor Made Scrub Hats — "Custom Teams" Project Handoff Brief

_Last updated: June 11, 2026_

This document is a complete handoff so the project can continue with full continuity on a new
computer / Cowork workspace. It covers what the project is, how it's built, what's been done,
what's left, and exactly what you'll need to set up again.

---

## 1. What this project is

**Custom Teams** is a hosted web app for managing Taylor Made Scrub Hats' **custom orders** (team /
bulk / embroidered / printed orders — as opposed to regular retail inventory). It replaces the old
workflow of tracking custom orders by hand across monthly Google Sheets.

It gives you, in one place:
- Every custom customer and their order history (with repeat-customer detection)
- Per-order production timeline / status (Cut → Embroidery → Sew → Fold → Ship → Delivered)
- Embroidery specs (thread colors, placement, logo notes) and mockup images per order
- Lead-only financials (invoice, materials, labor, shipping, profit, margin) and analytics
- Automatic syncing from Shopify (orders) and Clockify (labor time)

**Two roles:**
- **Lead** — sees everything, including Financials and the Analytics view; can Import.
- **Team** — sees orders, timelines, specs, and mockups, but **no Financials and no Analytics**.

---

## 2. Live locations (bookmark these)

| Thing | URL / identifier |
|---|---|
| **Live app** | https://customteams.vercel.app |
| **GitHub repo** (source of truth, auto-deploys) | https://github.com/twahlgren-tmsh/customteams |
| **Supabase project** | Project ref `mvspfxwiuipswvjwvlsv` — https://supabase.com/dashboard/project/mvspfxwiuipswvjwvlsv |
| **Supabase REST base** | https://mvspfxwiuipswvjwvlsv.supabase.co/rest/v1 |
| **Edge function** | `sync-orders` (Supabase Functions) |
| Business reference | `TMSH Business Brief (Claude reference) copy.pdf` (in this folder) |

---

## 3. Tech stack & architecture

- **Front end:** a single file, `index.html` — vanilla JS + Supabase JS client (loaded from CDN).
  No build step. The whole app is this one file.
- **Hosting:** **Vercel**, connected to the **GitHub repo**. Any commit to `main` auto-deploys in
  ~1 minute. (We deploy by uploading the file to GitHub via the web UI — see §10.)
- **Database / auth:** **Supabase** (Postgres + Auth + Storage). The app talks to it directly via
  PostgREST using the public anon key + the signed-in user's session.
- **Server logic:** one Supabase **edge function** `sync-orders` (Deno/TypeScript) that pulls from
  Shopify + Clockify and writes to the DB. It runs with the service-role key (server-side).
- **Automation:** a **weekly scheduled task** runs the sync to catch any orders that aged out of
  Shopify's recent-orders window.

Data flow:
```
Shopify (orders) ─┐
                  ├─► sync-orders edge function ─► Supabase Postgres ─► index.html (the app)
Clockify (labor) ─┘
```

---

## 4. Repository / file structure

GitHub repo `twahlgren-tmsh/customteams` (root):
- `index.html` — the entire app (UI, logic, styles all inline).
- `manifest.webmanifest` — PWA manifest (installable app, icon refs).
- `White Logo.png` — brand logo (white, transparent bg). Used in header + login. Served at
  `/White%20Logo.png`.
- `icon.png` — 512×512 app/bookmark icon (logo on black tile). Used for favicon, Apple touch icon,
  and PWA manifest.
- `icon-180.png` — older Apple-touch icon (now unreferenced; harmless).
- `supabase/` or a function file — the `sync-orders` edge function source (`index.ts`). _Note: the
  authoritative deployed copy lives in Supabase; keep the repo copy in sync when you edit it._

Local working folder (this folder, "Custom Orders"):
- `hosted/index.html` — the working copy we edit, then upload to GitHub to deploy.
- `hosted/manifest.webmanifest`
- `hosted/functions/sync-orders/index.ts` — working copy of the edge function.
- `White Logo.png` — the logo source.
- `TMSH Business Brief (Claude reference) copy.pdf` — costs, styles, materials reference.
- `HANDOFF_BRIEF.md` — this file.

---

## 5. ⭐ What you need to set up / connect on the new computer

This is the most important section for continuity. Re-establish these:

**Accounts & logins (have credentials ready):**
1. **Claude desktop app with Cowork mode** — install it, then **connect this project folder**
   ("Custom Orders") so Claude can read/write the files again.
2. **GitHub** — log in as the account with push access to `twahlgren-tmsh/customteams` (deploys go
   through GitHub's web UI in the browser).
3. **Supabase** — log in to the account that owns project `mvspfxwiuipswvjwvlsv` (for schema
   changes, the SQL editor, edge-function edits, and viewing secrets).
4. **Vercel** — log in to the account linked to the GitHub repo (only needed to check deploys; it's
   automatic).
5. **The app itself** — your **Lead** login (email + password) for customteams.vercel.app.

**Connectors to re-add in Claude/Cowork** (these power the data work):
- **Shopify** (Taylor Made Scrub Hats store) — for pulling order details.
- **Clockify** — for labor time.
- **Google Drive + Google Sheets** — for reading the monthly "Team [Month] [Year]" production
  sheets (embroidery specs + mockups).
- **Gmail / Google Calendar** — optional; were available but not central.

**Browser tooling:**
- **Claude in Chrome** extension — used heavily for deploying (GitHub uploads) and for running
  direct database operations from the app page. Install + sign in.

**Secrets you should NOT need to recreate (they live server-side in Supabase):**
- The edge-function secrets (Shopify Admin API token, Clockify API key, Supabase service-role key)
  are stored in **Supabase → Edge Functions → secrets**. They persist. Only touch them if you
  rotate keys. If the sync ever stops working, check these first.

**Nothing to install locally for the app** — there's no local build. Editing = change
`hosted/index.html`, upload to GitHub, Vercel deploys.

---

## 6. Data model (Supabase Postgres)

**`customers`**
- `id` (uuid), `name`, `contact`, `created_at`, `updated_at`
- _Note:_ customer **email is currently stored inside the `contact` field** (often as
  "Person Name · email@domain"). There is **no dedicated `email` column yet** (see §11). The app
  parses the email out for display/search.

**`orders`**
- `id` (uuid), `customer_id` (fk), `order_number` (Shopify #), `order_date`, `deadline` (customer),
  `internal_deadline` (goal), `est_ship`, `ship_date`, `delivered_date`
- `order_type` (array: Embroidery / Custom Print / Patch), `status`, `total_hats`, `styles`
- `scrub_color`, `logo`, `ribbon`, `sewing_thread`, `embroidery_thread`, `placement`, `font_option`
- `notes` (free text — embroidery spec block lives here), `mockup_url` (image data URL)
- `clockify_project_id`, `milestones` (jsonb: {placed, cut, embroidery, sew, fold, shipped, ...}),
  `has_digitizing`

**`order_financials`** (Lead-only)
- `order_id` (fk), `invoice_total`, `materials_cost`, `labor_cost`, `shipping_charged`,
  `shipping_cost`, `updated_at`

Roughly **187 customers / ~228 orders** after the de-duplication work.

---

## 7. Features completed (what the app does today)

- **Customer list + search** — search matches customer **name, email, order number, or internal
  order name**.
- **Order detail** — fields, clickable production **timeline** (click a step to mark done with
  today's date), embroidery spec fields, and **mockup image**.
- **Mockup images** — click to **zoom full-screen**; separate "Replace" / "Remove" buttons (clicking
  the image no longer triggers re-upload).
- **In-progress view** — all open (not shipped/delivered) orders sorted by deadline.
- **Analytics view (Lead only)** — volume, production timing (avg order→ship, order→delivered),
  financials (invoiced, profit, AOV, margin, avg materials/labor/shipping per order), order mix;
  with a date-range filter (30/90/YTD/1yr/all/**custom range**). **Hidden entirely from Team.**
- **Financials (Lead only)** — per order: invoice, materials, labor (real Clockify or **estimated**
  from category average when shipped but no Clockify data), shipping collected/cost, profit, margin.
- **Mobile / PWA** — installable; on mobile the In-progress / Analytics / selected-order detail open
  **above** the list; brand logo + icon.
- **Branding** — Taylor Made Scrub Hats logo in the header (big, centered) and login screen; app /
  bookmark icon is the logo on a black tile.
- **Shopify + Clockify sync** — "Refresh" button + weekly scheduled task. Pulls new orders,
  invoice/shipping totals, shipping cost (from Shopify timeline events), and labor.
- **Auto Clockify project** — when an internal team name is saved on an order, a Clockify project
  named `Custom: {internal name}` is created under the "Custom" client (idempotent; new orders only).
- **Embroidery specs + mockups backfilled** — from the monthly Google production sheets into ~46
  orders (notes + thread/logo/placement/font fields + mockup images).
- **Repeat-customer propagation** — within a repeat customer, a sibling order's mockup + spec notes
  fill any of their orders that were missing them (notes are **appended, never overwritten**).
- **Customer/order de-duplication** — merged 25 duplicate profile pairs (same person had a
  design-named profile + a Shopify/email profile) and collapsed a duplicated NYU Robotics order.

---

## 8. The monthly Google Sheets system (important context)

The shop runs production from monthly Google Sheets titled **"Team [Month] [Year]"** (e.g. "Team
April 2026"), in the owner's Google Drive. Each sheet has:
- A **Status board** / production schedule.
- One **tab per custom order**. Naming convention has changed over time:
  - Recent: `--85. Visionary Eye Navy` (`--NN. Name`)
  - Mid: plain names like `LSU Purple`, `ACME Black`
  - Newest: `108. Robotics Black Patch` (`NNN. Name`)
- Lower-numbered tabs like `1. New Year`, `26. Fruit Loops` are **seasonal/restock batches, not
  custom orders**. `* Inventory` and date tabs (`11/24`) are not orders.

Each order tab contains a **time-study block** and an **embroidery spec block** (thread color
numbers like `white 001`, `green 507`, `N262`; placements like `1" from bottom`; logo/ties/ribbon
notes; font). The spec block's **column position varies per tab**. Mockup images are over-cell
images on the tab.

Sheets identified (Drive): Team **November 2025, December 2025, January 2026, February 2026,
March 2026, April 2026** (plus older 2024/2025 sheets with different formats). Specs + mockups were
pulled from the six modern months.

**How specs were extracted (for future runs):** the sheets are private, so `gviz` JSON needs OAuth,
but **`gviz` CSV with the `sheet=<tabname>` parameter works with the logged-in Google session**:
`https://docs.google.com/spreadsheets/d/{id}/gviz/tq?tqx=out:csv&headers=0&sheet={tabName}` —
run from a docs.google.com browser tab. A "strong-cell" detector finds the spec column (cells
matching thread-color / placement / font patterns), and step/time-study labels are filtered out.
Mockups were read as same-origin `blob:` `<img>` elements on each tab, drawn to a canvas, downscaled
to ~520px JPEG data URLs, and saved to `orders.mockup_url`.

---

## 9. Business rules & formulas (key decisions)

- **Materials cost** (per order, per line item):
  - **Custom Print (CPSH)** hats → Little Cocalico fabric at **$25/yard**. Yards = Σ(qty × inches
    per style ÷ 36), **rounded UP** to the next whole yard. Plus per-style "other" materials.
  - **Embroidered/solid (CESH/CSH)** hats → MDG per-variant cost (includes elastic/ribbon/toggle/
    satin/label/bag per the Business Brief).
  - **Digitizing** → $9 simple / $14 complex.
  - The **$25/yd Little Cocalico price applies ONLY to custom orders**, not the inventory category
    cost. **Wholesale orders use MDG cost, not Cocalico.**
- **Labor:** real Clockify time when available; otherwise, for **shipped** orders only, **estimate**
  from the average labor-per-hat in that category (Embroidery vs Custom Print). Unshipped orders get
  **no** labor estimate (the number will come from Clockify when complete).
- **Only custom orders with ≥5 hats** were imported from Shopify history.
- **Order #57024 = 386 hats, all CO (Custom Original), MDG base cost.** Embroidered orders break the
  embroidery out as its own line item.
- **Do NOT create Clockify projects for past orders** — only on new internal-name entry.
- For delivered orders: mark every milestone complete, but only put **dates** on placed / shipped /
  delivered.

(See the Business Brief PDF for full per-variant costs and style codes: CO/CP/CT/CS, LO/LP/LT/LS,
classic vs luxe, etc.)

---

## 10. How to make changes & deploy (runbook)

**App (index.html) changes:**
1. Edit `hosted/index.html` in this folder.
2. Go to https://github.com/twahlgren-tmsh/customteams/upload/main in the browser (logged into
   GitHub).
3. Drag/upload the edited `index.html` (and any other changed files — manifest, images).
4. Enter a commit message → **Commit changes**.
5. Vercel auto-deploys in ~1 min. Hard-refresh the app (or bump the `?v=N` query) to see it.

> Deploy quirk: when committing via the GitHub web UI through automation, the "Commit changes"
> button sometimes needs `form.requestSubmit(button)` rather than a plain click. Doing it manually in
> a normal browser is straightforward.

**Database changes (DDL like adding a column):** use the **Supabase SQL editor**
(https://supabase.com/dashboard/project/mvspfxwiuipswvjwvlsv/sql/new). PostgREST/REST can do
row updates but **not** schema changes.

**Edge function changes:** edit in Supabase → Edge Functions → `sync-orders` (and keep the repo copy
in sync). It needs the Shopify/Clockify/service-role secrets (already set).

---

## 11. Known issues / left to do (backlog)

1. **Dedicated `email` column on `customers`** — _not done._ The Supabase dashboard would not load in
   the prior environment, so the column couldn't be created. Email currently lives in the `contact`
   field (searchable + displayed via parsing). **To finish:** run in the SQL editor:
   ```sql
   ALTER TABLE customers ADD COLUMN IF NOT EXISTS email text;
   ```
   Then split the email out of `contact` into `email`, point the app at the real column, and update
   `sync-orders` to populate it so it stays filled.
2. **Sync may re-create merged duplicates over time.** The sync creates a customer per Shopify
   contact, so it could re-introduce some of the 25 merged duplicates. **Fix:** update `sync-orders`
   to match existing customers by email before creating a new one.
3. **Orders not in the app / unnamed recent orders** — a few very recent orders weren't matched to
   monthly-sheet specs because they lacked an internal name in the app at the time. Re-running the
   spec/mockup backfill after names are set would catch them.
4. **Tabs with no cell spec** (e.g., some print orders) genuinely have no embroidery text on the
   sheet — nothing to import for those.
5. **Older monthly sheets (2024 / early 2025)** use different formats and mostly predate the app's
   order set; not processed. Low priority.
6. **Icon background** — currently black (matches the original logo). Could switch to brand teal
   (`#045863`) if preferred.

---

## 12. Decisions & conversation history (condensed)

- Built the schema, seeded historical custom orders from Shopify, built the app + sync function.
- Added internal team name + dual deadlines (customer vs goal) + clickable timeline.
- Materials auto-calc from the Business Brief; corrected Little Cocalico to $25/yd, round **up**, for
  custom print only; per-line calculation so mixed print+embroidery orders cost correctly.
- Added labor estimates by category, gated to shipped orders only.
- Backfilled invoice totals, shipping collected, shipping cost (from Shopify timeline events),
  delivery dates, and milestones; made shipping cost part of the ongoing sync.
- Auto-create Clockify project on internal-name save (`Custom: {name}`, "Custom" client).
- Built mobile/PWA layout + Analytics view (Lead only) with date filters.
- Backfilled embroidery specs (notes + thread/logo/placement/font) and mockup images from the six
  modern monthly sheets (~46 orders each).
- Added multi-field search; mockup click-to-zoom; mobile "detail above list."
- Propagated mockups/notes across repeat orders (append, never overwrite).
- Merged 25 duplicate customer profiles; collapsed a duplicated NYU Robotics order; CTO Print
  confirmed as one person (Jennifer Zeledon); Texas Spine all under Tammy Lucas.
- Restricted Analytics to Lead only.
- Added the brand logo to header + login and as the app/bookmark icon; then enlarged + centered it.

---

## 13. Quick-start checklist on the new computer

- [ ] Install Claude desktop (Cowork) + Claude in Chrome extension; sign in.
- [ ] Connect this **Custom Orders** folder in Cowork.
- [ ] Re-add connectors: Shopify, Clockify, Google Drive, Google Sheets.
- [ ] Confirm logins: GitHub (`twahlgren-tmsh`), Supabase (project `mvspfxwiuipswvjwvlsv`), Vercel,
      and your app Lead login.
- [ ] Open the app (customteams.vercel.app), sign in, click **Refresh** to confirm the sync works.
- [ ] (Optional first task) Add the `email` column (§11 #1) and update the sync to dedupe by email
      (§11 #2).

---

_Questions Claude can pick up immediately on the new machine: "read the HANDOFF_BRIEF.md in this
folder and continue the Custom Teams project."_
