// ============================================================
// Taylor Made — Custom Orders  ·  sync-orders Edge Function
// Pulls tag:custom orders from Shopify, parses them, upserts into
// the database, matches a Clockify project by the order's internal
// team name, and pulls labor cost. Called by the app's Refresh button.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   SHOPIFY_STORE_DOMAIN   e.g. taylor-made-scrub-hats.myshopify.com
//   SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET  (client_credentials grant)
//   CLOCKIFY_API_KEY / CLOCKIFY_WORKSPACE_ID
//   CLOCKIFY_CREATE = "true" to auto-create a project for NEW orders (off by default)
// (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Production logic:
//   • Line item title CPSH = custom print, CESH = embroidery.
//   • SKU CSH-DF-… = digitizing fee  → adds a "digitizing" timeline step.
//   • Hat styles = SKU CSH-(CO|CS|CP|CT|LO|LS|LP|LT) (handles doubled CSH-CP-CP).
//   • <5 hats or wholesale → skipped.
//   • Timeline: placed → digitizing* → materials → cut → embroidery* → sewing
//       → packaged(inspection/folded) → shipped → delivered   (*print orders skip both)
//   • EXISTING orders: only delivery/status/milestones are refreshed; manual
//       progress and edited fields are preserved (milestones are MERGED).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// ---------- helpers ----------
const STYLE_RE = /^CSH-(CO|CS|CP|CT|LO|LS|LP|LT)(?:-|$)/i;

function parseNote(note: string): Record<string, string> {
  const d: Record<string, string> = {};
  (note || "").split("\n").forEach((line) => {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) d[k] = v;
    }
  });
  return d;
}
const getKey = (d: Record<string, string>, sub: string) => {
  const k = Object.keys(d).find((k) => k.toLowerCase().includes(sub));
  return k ? d[k] : "";
};
const mdy = (s: string): string | null => {
  const m = (s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const isoDate = (s: string | null | undefined): string | null =>
  s ? s.slice(0, 10) : null;
const norm = (s: string) =>
  (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const nz = (v: string | null | undefined) => (v && ("" + v).length ? v : null);

type MS = Record<string, { done: boolean; date: string }>;
// Build the milestone object: canonical skeleton for this order's type,
// overlaid with any existing (manual) progress, then delivery from Shopify.
function buildMs(
  existing: MS | null,
  o: { placedDate: string; shipDate: string | null; delivered: string | null; emb: boolean; digit: boolean },
): MS {
  const steps = ["placed"];
  if (o.digit) steps.push("digitizing");
  steps.push("materials", "cut");
  if (o.emb) steps.push("embroidery");
  steps.push("sewing", "packaged", "shipped", "delivered");
  const ex = existing || {};
  const ms: MS = {};
  for (const k of steps) {
    const e = ex[k];
    ms[k] = e ? { done: !!e.done, date: e.date || "" } : { done: false, date: "" };
  }
  ms.placed = { done: true, date: (ex.placed && ex.placed.date) || o.placedDate || "" };
  if (o.shipDate) {
    ["materials", "cut", "sewing", "packaged", "shipped"].forEach((k) => (ms[k].done = true));
    if (o.emb) ms.embroidery.done = true;
    if (o.digit) ms.digitizing.done = true;
    ms.shipped.date = ms.shipped.date || o.shipDate;
  }
  if (o.delivered) { ms.delivered.done = true; ms.delivered.date = o.delivered; }
  return ms;
}

// ---------- Shopify ----------
async function shopifyToken(domain: string, clientId: string, clientSecret: string) {
  const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Shopify token: " + JSON.stringify(j).slice(0, 200));
  return j.access_token as string;
}
async function shopifyOrders(domain: string, token: string, limit = 50) {
  const q = `query($cursor:String){
    orders(first:50, after:$cursor, query:"tag:custom", sortKey:CREATED_AT, reverse:true){
      pageInfo{ hasNextPage endCursor }
      edges{ node{
        name createdAt note tags
        customer{ firstName lastName email }
        lineItems(first:50){ edges{ node{ quantity sku title variantTitle } } }
        fulfillments{ createdAt deliveredAt status }
      } }
    }
  }`;
  const out: any[] = [];
  let cursor: string | null = null;
  while (out.length < limit) {
    const r = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { cursor } }),
    });
    const j = await r.json();
    if (j.errors) throw new Error("Shopify: " + JSON.stringify(j.errors));
    const conn = j.data.orders;
    conn.edges.forEach((e: any) => out.push(e.node));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out.slice(0, limit);
}

// ---------- Clockify ----------
const CLK = "https://api.clockify.me/api/v1";
const RPT = "https://reports.api.clockify.me/v1";
async function clockifyProjects(wid: string, key: string) {
  const out: any[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${CLK}/workspaces/${wid}/projects?page-size=200&page=${page}&archived=false`, { headers: { "X-Api-Key": key } });
    if (!r.ok) break;
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < 200) break;
  }
  return out;
}
async function clockifyCreate(wid: string, key: string, name: string) {
  const r = await fetch(`${CLK}/workspaces/${wid}/projects`, {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ name, isPublic: true, billable: true }),
  });
  if (!r.ok) throw new Error("Clockify create: " + (await r.text()));
  return await r.json();
}
async function clockifyCost(wid: string, key: string, projectId: string) {
  const r = await fetch(`${RPT}/workspaces/${wid}/reports/summary`, {
    method: "POST",
    headers: { "X-Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      // plan caps how far back reports can go (~1yr); stay inside it
      dateRangeStart: new Date(Date.now() - 360 * 864e5).toISOString(),
      dateRangeEnd: new Date().toISOString(),
      // EARNED = billable amount from per-person hourly rates (the "Amount"
      // shown on the Clockify projects screen). COST/PROFIT need the paid
      // cost-analysis toggle; EARNED does not.
      amountShown: "EARNED",
      summaryFilter: { groups: ["PROJECT"] },
      projects: { ids: [projectId], contains: "CONTAINS" },
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const t = (j.totals || [])[0];
  if (!t) return 0;
  const amt = typeof t.totalAmount === "number" ? t.totalAmount : 0;
  return Math.round(amt) / 100;
}

// ---------- main ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const SHOP_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
    const SHOP_CLIENT_ID = Deno.env.get("SHOPIFY_CLIENT_ID") || "";
    const SHOP_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") || "";
    const SHOP_STATIC = Deno.env.get("SHOPIFY_ADMIN_TOKEN") || "";
    const CLK_KEY = Deno.env.get("CLOCKIFY_API_KEY") || "";
    const CLK_WID = Deno.env.get("CLOCKIFY_WORKSPACE_ID") || "";
    const CLK_CREATE = (Deno.env.get("CLOCKIFY_CREATE") || "").toLowerCase() === "true";

    const auth = req.headers.get("Authorization") || "";
    const sb = createClient(SUPABASE_URL, SERVICE);
    const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
    if (!u?.user) return json({ error: "Not authorized" }, 401);

    // ---- one-time labor backfill: pull Clockify cost for every linked order ----
    const url = new URL(req.url);
    let mode = url.searchParams.get("mode");
    if (!mode) { try { const b = await req.clone().json(); mode = b && b.mode; } catch (_e) { /* no body */ } }
    if (mode === "labor") {
      if (!(CLK_KEY && CLK_WID)) return json({ error: "Clockify not configured" }, 400);
      const { data: linked } = await sb.from("orders")
        .select("id, clockify_project_id").not("clockify_project_id", "is", null);
      const t0 = Date.now();
      let done = 0, remaining = 0;
      for (const o of (linked || [])) {
        if (Date.now() - t0 > 120_000) { remaining++; continue; }
        try {
          const cost = await clockifyCost(CLK_WID, CLK_KEY, o.clockify_project_id);
          if (cost !== null) {
            await sb.from("order_financials").upsert(
              { order_id: o.id, labor_cost: cost }, { onConflict: "order_id" },
            );
            done++;
          }
        } catch (_e) { /* skip */ }
      }
      return json({ ok: true, mode: "labor", linkedTotal: (linked || []).length, done, remaining });
    }

    const shopToken = SHOP_STATIC ||
      await shopifyToken(SHOP_DOMAIN, SHOP_CLIENT_ID, SHOP_CLIENT_SECRET);
    const orders = await shopifyOrders(SHOP_DOMAIN, shopToken, 50);

    const { data: existing } = await sb.from("orders")
      .select("id, order_number, clockify_project_id, status, internal_name, milestones");
    const exMap = new Map((existing || []).map((o: any) => [o.order_number, o]));

    const clkOn = !!(CLK_KEY && CLK_WID);
    const projIndex = new Map<string, any>();
    if (clkOn) {
      try {
        const list = await clockifyProjects(CLK_WID, CLK_KEY);
        list.forEach((p) => projIndex.set(norm(p.name), p));
      } catch (_e) { /* clockify optional */ }
    }

    const started = Date.now();
    let created = 0, updated = 0, skipped = 0, clkLinked = 0, clkMade = 0;

    for (const o of orders) {
      // ---- line items → hats, styles, type, digitizing ----
      const styleCount: Record<string, number> = {};
      let hats = 0, hasPrint = false, hasEmb = false, hasDigit = false, hasWhole = false;
      for (const e of o.lineItems.edges) {
        const li = e.node;
        const sku = (li.sku || "");
        const m = sku.match(STYLE_RE);
        if (m) { const c = m[1].toUpperCase(); styleCount[c] = (styleCount[c] || 0) + li.quantity; hats += li.quantity; }
        const tt = (li.title || "").trim().toUpperCase();
        if (tt === "CPSH") hasPrint = true;        // custom print
        else if (tt === "CESH") hasEmb = true;      // embroidery
        else if (tt === "CSH") hasWhole = true;     // wholesale customer
        if (/CSH-EM/i.test(sku)) hasEmb = true;
        if (/CSH-DF/i.test(sku)) hasDigit = true;
      }
      if (hats < 5) { skipped++; continue; }
      const styles = Object.entries(styleCount).map(([c, n]) => `${n} ${c}`).join(" + ");

      // ---- note ----
      const d = parseNote(o.note || "");
      const types = new Set<string>();
      if (hasWhole) types.add("Wholesale");
      if (hasPrint) types.add("Custom Print");
      if (hasEmb) types.add("Embroidery");
      if (getKey(d, "patch")) types.add("Patch");
      const deadlineYes = /yes/i.test(getKey(d, "deadline for delivery"));
      const deadline = deadlineYes ? mdy(getKey(d, "date needed")) : null;
      const scrub = getKey(d, "scrub hat base color") || getKey(d, "scrub hat color") || getKey(d, "scrub hat color(s)");
      const placement = getKey(d, "placement");
      const embThread = getKey(d, "text color preference") || getKey(d, "thread color");
      const font = getKey(d, "font");
      const noteBits: string[] = [];
      const overview = getKey(d, "project overview");
      const text = getKey(d, "exact text");
      const buttons = getKey(d, "sewn-on buttons");
      if (overview) noteBits.push(overview);
      if (text) noteBits.push(`Text: ${text}`);
      if (buttons && /yes/i.test(buttons)) noteBits.push("Sewn-on buttons: Yes");
      const notes = noteBits.join(" | ") || null;

      // ---- fulfillment / milestones ----
      const f = (o.fulfillments || [])[0];
      const shipDate = f ? isoDate(f.createdAt) : null;
      const delivered = f ? isoDate(f.deliveredAt) : null;
      const status = delivered ? "Delivered" : (f ? "Shipped" : "Ordered");
      const placedDate = isoDate(o.createdAt) || "";
      const ex = exMap.get(o.name);
      const isNew = !ex;
      const ms = buildMs(ex ? ex.milestones : null, { placedDate, shipDate, delivered, emb: hasEmb, digit: hasDigit });

      // ---- customer (only for new orders) ----
      let customerId: string | null = null;
      if (isNew) {
        const c = o.customer || {};
        const name = `${c.firstName || ""} ${c.lastName || ""}`.trim() || "Unknown";
        const email = c.email || null;
        const { data: foundC } = await sb.from("customers").select("id")
          .or(email ? `contact.eq.${email},name.eq.${name}` : `name.eq.${name}`).limit(1).maybeSingle();
        if (foundC) customerId = foundC.id;
        else {
          const { data: newC } = await sb.from("customers").insert({ name, contact: email }).select("id").single();
          customerId = newC?.id ?? null;
        }
      }

      // ---- clockify: match existing project by the order's internal name ----
      let projId: string | null = ex?.clockify_project_id || null;
      const iname: string = (ex?.internal_name || "").trim();
      if (clkOn && !projId && iname) {
        const match = projIndex.get(norm(iname));
        if (match) { projId = match.id; clkLinked++; }
      } else if (clkOn && !projId && CLK_CREATE && isNew) {
        // (off by default; never backfills past orders)
        try {
          const c = o.customer || {};
          const nm = `${o.name} ${`${c.firstName || ""} ${c.lastName || ""}`.trim()}`.trim();
          const p = await clockifyCreate(CLK_WID, CLK_KEY, nm);
          projId = p.id; clkMade++;
        } catch (_e) { /* leave unlinked */ }
      }

      // ---- upsert (existing = light touch; preserve manual fields) ----
      const row: Record<string, unknown> = {
        order_number: o.name,
        order_date: placedDate || null,
        deadline,
        ship_date: shipDate,
        delivered_date: delivered,
        order_type: [...types],
        status,
        has_digitizing: hasDigit,
        milestones: ms,
      };
      if (isNew) Object.assign(row, {
        customer_id: customerId,
        styles: nz(styles),
        total_hats: hats,
        scrub_color: nz(scrub),
        placement: nz(placement),
        embroidery_thread: nz(embThread),
        font_option: nz(font),
        notes,
      });
      if (projId) row.clockify_project_id = projId;

      const { error: upErr } = await sb.from("orders").upsert(row, { onConflict: "order_number" });
      if (upErr) { skipped++; continue; }
      isNew ? created++ : updated++;

      // ---- labor cost (best effort, time-bounded) ----
      if (clkOn && projId && Date.now() - started < 110_000) {
        try {
          const cost = await clockifyCost(CLK_WID, CLK_KEY, projId);
          if (cost !== null) {
            const { data: ord } = await sb.from("orders").select("id").eq("order_number", o.name).single();
            if (ord) await sb.from("order_financials").upsert({ order_id: ord.id, labor_cost: cost }, { onConflict: "order_id" });
          }
        } catch (_e) { /* skip labor */ }
      }
    }

    return json({
      ok: true, scanned: orders.length, created, updated, skipped,
      clockify: { linked: clkLinked, created: clkMade, enabled: clkOn },
    });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
