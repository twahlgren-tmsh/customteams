// ============================================================
// pack-orders v12 helpers — plain JS so Node can unit-test them.
//
// Bold Product Options (the add-on builder) writes the customer's
// choices as custom attributes on the HAT line:
//   "Sewn-on Buttons" / "Sewn on Buttons"  → "✓" when chosen
//   "Embroidery Add-on"                    → "✓" when chosen
//   "Text to be embroidered Hat #1:"       → the text
//   "Embroidery Font Color Hat #1"         → hex, e.g. #e63b7a
//   "Font Style "                          → 1–4
//   "Embroidery Location"                  → Above Left Ear / Above Right Ear
//   "Embroidery Placement "                → Along Bottom Edge / 2" Above Bottom Edge…
//   "Embroidered Ribbon"                   → No Ribbon / …
//   "_boldBuilderId"                       → links the hat to its add-on lines
// The priced add-ons ("Button Set (Sewn On)", "Embroidery Add-on")
// are SEPARATE line items that carry only the same _boldBuilderId.
// ============================================================

const ADDON_TITLE = /^(button set|embroidery add-?on)/i;
const STYLE_START = /^(luxe\s+|classic\s+)?(skull(\s*hat)?|ponytail|taylor'?ed\s*euro|euro|(the\s+)?original|headband)\b/i;
// Fees, surcharges, logo/print/embroidery charges and samples on custom orders.
const SERVICE_TITLE = /surcharge|\brush\b|jump the line|\bfees?\b|digitiz|set-?up|custom printed|printed logo|\blogo\b|swatch/i;
const CUSTOM_LISTING = /^(cesh|csh|cpsh)$/i;
const CHECKED = /✓|✔|^yes$|^true$|^checked$/i;

export function parseAttrs(attrs) {
  attrs = attrs || [];
  const vis = attrs.filter((a) => a && a.key && !a.key.startsWith("_") && String(a.value ?? "").trim() !== "");
  const get = (re) => { const a = vis.find((x) => re.test(x.key)); return a ? String(a.value).trim() : null; };
  const checked = (re) => vis.some((a) => re.test(a.key) && CHECKED.test(String(a.value).trim()));
  const builderAttr = attrs.find((a) => a && a.key === "_boldBuilderId");

  const buttons = checked(/sewn[\s-]*on\s*buttons?/i);
  const embOn = checked(/embroidery\s*add[\s-]*on/i);

  // One text / color per hat number ("Hat #1", "Hat #2", …). Keys without a
  // number count as hat 1.
  const texts = {}, colors = {};
  for (const a of vis) {
    const m = a.key.match(/#\s*(\d+)/);
    const n = m ? Number(m[1]) : 1;
    if (/text.*embroider/i.test(a.key)) texts[n] = String(a.value).trim();
    else if (/font\s*colou?r/i.test(a.key)) colors[n] = String(a.value).trim();
  }
  const nums = [...new Set([...Object.keys(texts), ...Object.keys(colors)].map(Number))].sort((x, y) => x - y);

  let embroidery = null;
  if (embOn || nums.length) {
    embroidery = {
      hats: nums.map((n) => ({ n, text: texts[n] || null, color: colors[n] || null })),
      font: get(/font\s*style/i),
      location: get(/embroidery\s*location/i),
      placement: get(/embroidery\s*placement/i),
      ribbon: get(/ribbon/i),
    };
  }

  const KNOWN = /sewn[\s-]*on\s*buttons?|embroidery\s*add[\s-]*on|text.*embroider|font\s*(style|colou?r)|embroidery\s*location|embroidery\s*placement|ribbon/i;
  const other = vis.filter((a) => !KNOWN.test(a.key)).map((a) => ({ key: a.key.trim(), value: String(a.value).trim() }));

  return {
    builderId: builderAttr ? String(builderAttr.value) : null,
    hasOptionKeys: attrs.some((a) => a && a.key && !a.key.startsWith("_")),
    buttons,
    embroidery,
    other,
  };
}

// Classify a mapped line item. Mutates and returns it.
export function classifyLine(li, productType) {
  const p = parseAttrs(li._attrs);
  li.builderId = p.builderId;
  li.addons = { buttons: p.buttons, embroidery: p.embroidery, other: p.other };
  const hiddenType = /options_hidden/i.test(productType || "");
  // An add-on CHILD line: priced add-on carrying only the builder id.
  li.isAddon = !!(p.builderId && !p.hasOptionKeys && (ADDON_TITLE.test(li.title || "") || hiddenType));
  // A service line on a custom order (logo, digitizing, fees) or an
  // order-wide button set with no hat to attach to: never picked or scanned.
  const customListing = CUSTOM_LISTING.test((li.title || "").trim());
  li.isService = !li.isAddon && (
    (customListing && !STYLE_START.test((li.variantTitle || "").trim())) ||
    (ADDON_TITLE.test(li.title || "") && !p.builderId)
  );
  delete li._attrs;
  return li;
}

// Attach each add-on child to its hat (same _boldBuilderId).
export function linkAddons(order) {
  // Fees / surcharges / printed-logo charges / swatches — only on CUSTOM orders, and never a
  // "… Scrub Hat" product (retail names like "Blush Rush" must stay hats).
  if (order.isCustom) {
    for (const it of order.items) {
      if (it.isAddon || it.isService || CUSTOM_LISTING.test((it.title || "").trim())) continue;
      if (/scrub hat/i.test(it.title || "")) continue;
      if (SERVICE_TITLE.test(it.title || "")) it.isService = true;
    }
  }
  const parents = new Map();
  for (const it of order.items) if (it.builderId && !it.isAddon) parents.set(it.builderId, it);
  for (const it of order.items) {
    if (!it.isAddon) continue;
    const p = parents.get(it.builderId);
    if (!p) { it.isAddon = false; it.isService = true; it.orphanAddon = true; continue; }   // no hat found: show as an order-level note, never scanned
    it.parentLineId = p.lineId;
    (p.addonLines = p.addonLines || []).push({ lineId: it.lineId, title: it.title, qty: it.qty });
  }
  // Button sets that couldn't be tied to a hat (bought on their own, or the
  // builder lost the link). If their count equals the hats on the order that
  // don't already have buttons, every one of those hats gets buttons —
  // flagged `buttonsInferred` so the screen can say "check the order".
  const looseButtons = order.items.filter((i) => i.isService && /^button set/i.test(i.title || "") && !order.isCustom);
  const looseQty = looseButtons.reduce((s, i) => s + (i.qty || 0), 0);
  if (looseQty) {
    const hats = order.items.filter((i) => !i.isAddon && !i.isService && i.requiresShipping !== false && !(i.addons && i.addons.buttons));
    const hatUnits = hats.reduce((s, i) => s + (i.qty || 0), 0);
    if (hatUnits === looseQty) {
      hats.forEach((h) => { h.addons.buttons = true; h.buttonsInferred = true; });
      looseButtons.forEach((b) => { b.isAddon = true; b.isService = false; b.inferredAddon = true; });
    } else {
      order.looseButtonSets = looseQty;   // shown as an order-level warning
    }
  }
  return order;
}
