// ============================================================
// TMSH Barcode WMS · pack-orders v12
//   toPick        : open + unshipped/partial NON-custom orders (oldest first)
//   toPack        : NON-custom fulfilled in the last 21 days, NEWEST FIRST
//   toPickCustom  : open + unshipped/partial orders tagged "Custom" (v12)
//   toPackCustom  : "Custom" orders fulfilled in the last 30 days (v12)
//   ?backfill=1 : mark every current toPack order without a session
//     as verified.
//   v8 — no order cap: both pulls paginate until Shopify says done
//     (80-page safety ceiling), THROTTLED errors retry with backoff.
//   v9 (2026-08-30) — NO LINE-ITEM CAP + imageUrl per line.
//   v12 (2026-10-14) — add-ons on the right hat: every line gets
//     `addons` {buttons, embroidery{hats[{n,text,color}], font, location,
//     placement, ribbon}, other[]}, `builderId`, `isAddon` (a priced
//     add-on line folded under its hat via _boldBuilderId, with
//     `parentLineId`), `isService` (custom-order logo/digitizing/fee lines
//     and order-wide button sets — never picked or scanned). Hats carry
//     `addonLines`. Orders carry `isCustom`. Custom orders come back in
//     their own arrays so older pages are unaffected.
// Auth: user JWT or shared cron key (function does its own auth check
// below — verify_jwt must stay false or the cron path breaks).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { classifyLine, linkAddons } from "./addons.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function shopifyToken(domain: string, id: string, secret: string) {
  const r = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Shopify token: " + JSON.stringify(j).slice(0, 200));
  return j.access_token as string;
}

function stripHtml(s: string) {
  return (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Shared line-item field selection + mapper (main query and the
// per-order follow-up pagination query must stay in sync).
const LI_FIELDS = `id title variantTitle quantity unfulfilledQuantity sku requiresShipping
        image{ url(transform:{maxWidth:160, maxHeight:160}) }
        variant{ legacyResourceId barcode product{ legacyResourceId status productType } }
        customAttributes{ key value }`;

function mapLineItem(li: any) {
  const attrs: any[] = li.customAttributes || [];
  const colorAttr = attrs.find((a: any) => /font\s*color/i.test(a.key || "") && /^#[0-9a-f]{3,8}$/i.test((a.value || "").trim()));
  const textAttr = attrs.find((a: any) => /text.*embroider/i.test(a.key || ""));
  return classifyLine({
    lineId: li.id,
    title: li.title,
    variantTitle: li.variantTitle,
    qty: li.quantity,
    unfulfilledQty: li.unfulfilledQuantity,
    sku: li.sku || null,
    barcode: li.variant?.barcode || null,
    variantId: li.variant?.legacyResourceId || null,
    productStatus: li.variant?.product?.status || null,
    requiresShipping: li.requiresShipping,
    imageUrl: li.image?.url || null,
    embroideryColor: colorAttr ? colorAttr.value.trim() : null,
    embroideryText: textAttr ? textAttr.value : null,
    _attrs: attrs,
  }, li.variant?.product?.productType || "");
}

function mapOrder(o: any) {
  const items = o.lineItems.edges.map((le: any) => mapLineItem(le.node));
  const cDates = (o.customer?.orders?.edges || []).map((e: any) => e.node.createdAt);
  const timelineNotes = ((o.events && o.events.edges) || [])
    .map((e: any) => (e.node && e.node.__typename === "CommentEvent") ? stripHtml(e.node.message) : null)
    .filter((m: string | null) => !!m && m.length);
  return {
    gid: o.id,
    _liPage: o.lineItems.pageInfo || null,
    orderId: o.legacyResourceId,
    number: o.name,
    createdAt: o.createdAt,
    tags: o.tags,
    isCustom: (o.tags || []).some((t: string) => /^custom( order)?$/i.test((t || "").trim())),
    note: o.note || null,
    timelineNotes,
    fulfillment: o.displayFulfillmentStatus,
    financial: o.displayFinancialStatus,
    customer: o.shippingAddress?.name ||
      `${o.customer?.firstName || ""} ${o.customer?.lastName || ""}`.trim() || "—",
    customerId: o.customer?.legacyResourceId || null,
    destination: o.shippingAddress ? `${o.shippingAddress.city || ""}, ${o.shippingAddress.provinceCode || ""}` : null,
    ordersCount: o.customer?.numberOfOrders != null ? Number(o.customer.numberOfOrders) : null,
    orderDates: cDates,
    items,
  };
}

async function gql(domain: string, token: string, query: string, variables: any) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await fetch(`https://${domain}/admin/api/2024-10/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) {
      if ((j.errors as any[]).some((e: any) => e?.extensions?.code === "THROTTLED")) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      throw new Error("Shopify: " + JSON.stringify(j.errors).slice(0, 300));
    }
    return j.data;
  }
  throw new Error("Shopify: throttled after retries");
}

// v9: fetch any line items beyond the first 40 for one order.
async function fetchRemainingLines(domain: string, token: string, order: any) {
  const q = `query($id:ID!,$c:String){ node(id:$id){ ... on Order {
    lineItems(first:60, after:$c){ pageInfo{ hasNextPage endCursor } edges{ node{ ${LI_FIELDS} } } }
  } } }`;
  let cursor = order._liPage.endCursor;
  for (let page = 0; page < 20; page++) {
    const data = await gql(domain, token, q, { id: order.gid, c: cursor });
    const conn = data?.node?.lineItems;
    if (!conn) break;
    conn.edges.forEach((e: any) => order.items.push(mapLineItem(e.node)));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
}

// v8: paginate until Shopify reports no more pages (80-page ceiling).
async function fetchOrders(domain: string, token: string, search: string, reverse = false, maxPages = 80) {
  const q = `query($c:String){ orders(first:25, after:$c, query:${JSON.stringify(search)}, sortKey:CREATED_AT, reverse:${reverse ? "true" : "false"}){
    pageInfo{ hasNextPage endCursor }
    edges{ node{
      id legacyResourceId name createdAt tags note
      displayFulfillmentStatus displayFinancialStatus
      customer{ firstName lastName numberOfOrders legacyResourceId
        orders(first:4, sortKey:CREATED_AT, reverse:true){ edges{ node{ createdAt } } } }
      shippingAddress{ name city provinceCode }
      lineItems(first:40){ pageInfo{ hasNextPage endCursor } edges{ node{ ${LI_FIELDS} } } }
      events(first:5){ edges{ node{ __typename ... on CommentEvent{ message } } } }
    } }
  } }`;
  const out: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await gql(domain, token, q, { c: cursor });
    const conn = data.orders;
    conn.edges.forEach((e: any) => out.push(mapOrder(e.node)));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  // v9: complete any orders whose line items were truncated at 40.
  for (const o of out) {
    if (o._liPage?.hasNextPage) await fetchRemainingLines(domain, token, o);
    delete o._liPage; delete o.gid;
    linkAddons(o);   // v12: after ALL lines are in
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;

    const CRON_KEY = "tmsh-auto-pull-9d4f2a7c1e8b6035";
    const url = new URL(req.url);
    const keyOk = req.headers.get("x-cron-key") === CRON_KEY || url.searchParams.get("key") === CRON_KEY;
    if (!keyOk) {
      const auth = req.headers.get("Authorization") || "";
      const { data: u } = await sb.auth.getUser(auth.replace("Bearer ", ""));
      if (!u?.user) return json({ error: "Not authorized" }, 401);
    }

    const token = Deno.env.get("SHOPIFY_ADMIN_TOKEN") || await shopifyToken(
      DOMAIN, Deno.env.get("SHOPIFY_CLIENT_ID") || "", Deno.env.get("SHOPIFY_CLIENT_SECRET") || "");

    const day = 864e5;
    const cutoff = new Date(Date.now() - 21 * day).toISOString().slice(0, 10);
    const cutoffCustom = new Date(Date.now() - 30 * day).toISOString().slice(0, 10);
    const wantCustom = url.searchParams.get("custom") !== "0";
    const [toPickRaw, toPackRaw, toPickCustomRaw, toPackCustomRaw] = await Promise.all([
      fetchOrders(DOMAIN, token,
        "(fulfillment_status:unshipped OR fulfillment_status:partial) -tag:custom status:open -status:cancelled", false),
      fetchOrders(DOMAIN, token,
        `fulfillment_status:shipped -tag:custom -status:cancelled updated_at:>=${cutoff}`, true),
      wantCustom ? fetchOrders(DOMAIN, token,
        "(fulfillment_status:unshipped OR fulfillment_status:partial) tag:custom status:open -status:cancelled", false) : Promise.resolve([]),
      wantCustom ? fetchOrders(DOMAIN, token,
        `fulfillment_status:shipped tag:custom -status:cancelled updated_at:>=${cutoffCustom}`, true) : Promise.resolve([]),
    ]);

    const shippable = (o: any, useQty: string) =>
      o.items.some((i: any) => i.requiresShipping && !i.isAddon && !i.isService && i[useQty] > 0);
    const toPick = toPickRaw.filter((o: any) => shippable(o, "unfulfilledQty"));
    const toPack = toPackRaw.filter((o: any) => shippable(o, "qty"));
    const toPickCustom = toPickCustomRaw.filter((o: any) => shippable(o, "unfulfilledQty"));
    const toPackCustom = toPackCustomRaw.filter((o: any) => shippable(o, "qty"));

    if (url.searchParams.get("backfill") === "1") {
      const { data: sess } = await sb.from("pack_sessions").select("shopify_order_id");
      const have = new Set((sess || []).map((s: any) => s.shopify_order_id));
      const rows = toPack.filter((o: any) => !have.has(o.orderId)).map((o: any) => ({
        shopify_order_id: o.orderId, order_number: o.number, status: "verified",
        verified_at: new Date().toISOString(), items: { backfill: true },
      }));
      if (rows.length) {
        const { error } = await sb.from("pack_sessions").insert(rows);
        if (error) return json({ error: "backfill: " + error.message }, 500);
      }
      return json({ ok: true, backfilled: rows.length, toPack: toPack.length });
    }

    return json({
      ok: true, version: 12, toPick, toPack, toPickCustom, toPackCustom,
      counts: { toPick: toPick.length, toPack: toPack.length, toPickCustom: toPickCustom.length, toPackCustom: toPackCustom.length },
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
