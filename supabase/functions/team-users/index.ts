// ============================================================
// team-users v1 (2026-10-14) — lead-only login management for
// ShipShape + StitchLab. Individual logins are a username + 4-digit
// PIN. Under the hood each is a Supabase auth user whose email is
// <username>@staff.taylormadescrubhats.com (never mailed) and whose
// password is "tmsh-pin-<PIN>" — the pages build the same string.
//
// POST { action, ... } with the caller's JWT:
//   list                                  → roster
//   create { username, pin, display_name, role, person }
//   set_pin { user_id, pin }
//   update { user_id, display_name?, role?, person?, active?, username? }
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const DOMAIN = "staff.taylormadescrubhats.com";
const emailFor = (u: string) => `${u}@${DOMAIN}`;
const pwFor = (pin: string) => `tmsh-pin-${pin}`;
const cleanUser = (u: unknown) => String(u ?? "").trim().toLowerCase();
const okUser = (u: string) => /^[a-z][a-z0-9._-]{1,23}$/.test(u);
const okPin = (p: unknown) => /^\d{4}$/.test(String(p ?? ""));
const ROLES = new Set(["lead", "team"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: me } = await admin.auth.getUser(jwt);
    if (!me?.user) return json({ error: "Not signed in" }, 401);
    const { data: myProf } = await admin.from("profiles").select("role").eq("id", me.user.id).maybeSingle();
    if (myProf?.role !== "lead") return json({ error: "Only a lead can manage logins" }, 403);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    if (action === "list") {
      const { data: profs, error } = await admin.from("profiles")
        .select("id, full_name, display_name, username, role, person, active, created_at").order("created_at");
      if (error) return json({ error: error.message }, 500);
      const users: Record<string, any> = {};
      for (let page = 1; page < 20; page++) {
        const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        (data?.users || []).forEach((u: any) => { users[u.id] = u; });
        if (!data || (data.users || []).length < 200) break;
      }
      return json({ ok: true, people: (profs || []).map((p: any) => ({
        ...p,
        email: users[p.id]?.email || null,
        last_sign_in_at: users[p.id]?.last_sign_in_at || null,
        pin_login: !!users[p.id]?.email?.endsWith("@" + DOMAIN) || !!p.username,
      })) });
    }

    if (action === "create") {
      const username = cleanUser(body.username);
      if (!okUser(username)) return json({ error: "Username: letters/numbers only, 2–24 characters, starting with a letter" }, 400);
      if (!okPin(body.pin)) return json({ error: "PIN must be exactly 4 digits" }, 400);
      const role = ROLES.has(body.role) ? body.role : "team";
      const { data: taken } = await admin.from("profiles").select("id").ilike("username", username).maybeSingle();
      if (taken) return json({ error: "That username is already in use" }, 409);
      const { data: cu, error: ce } = await admin.auth.admin.createUser({
        email: emailFor(username), password: pwFor(String(body.pin)), email_confirm: true,
        user_metadata: { username, display_name: body.display_name || username },
      });
      if (ce || !cu?.user) return json({ error: "Create failed: " + (ce?.message || "unknown") }, 500);
      const row = {
        id: cu.user.id, full_name: body.display_name || username, display_name: body.display_name || username,
        username, role, person: body.person || null, active: true,
      };
      const { error: pe } = await admin.from("profiles").upsert(row);
      if (pe) return json({ error: "Profile: " + pe.message }, 500);
      return json({ ok: true, id: cu.user.id });
    }

    const uid = String(body.user_id || "");
    if (!uid) return json({ error: "user_id required" }, 400);
    const { data: prof } = await admin.from("profiles").select("*").eq("id", uid).maybeSingle();
    if (!prof) return json({ error: "No such person" }, 404);

    if (action === "set_pin") {
      if (!okPin(body.pin)) return json({ error: "PIN must be exactly 4 digits" }, 400);
      const patch: any = { password: pwFor(String(body.pin)) };
      // A person without a username yet (an old email login) gets one now, so the PIN works.
      let username = prof.username;
      if (!username) {
        username = cleanUser(body.username);
        if (!okUser(username)) return json({ error: "Pick a username for this person first" }, 400);
        const { data: taken } = await admin.from("profiles").select("id").ilike("username", username).neq("id", uid).maybeSingle();
        if (taken) return json({ error: "That username is already in use" }, 409);
      }
      // PIN sign-in looks the person up as <username>@staff…, so an old email login moves over
      // to that address (its old email + password stop working; the PIN replaces them).
      const { data: au } = await admin.auth.admin.getUserById(uid);
      if (!(au?.user?.email || "").endsWith("@" + DOMAIN)) { patch.email = emailFor(username); patch.email_confirm = true; }
      const { error } = await admin.auth.admin.updateUserById(uid, patch);
      if (error) return json({ error: error.message }, 500);
      if (!prof.username) await admin.from("profiles").update({ username }).eq("id", uid);
      return json({ ok: true });
    }

    if (action === "update") {
      if (uid === me.user.id && (body.role === "team" || body.active === false))
        return json({ error: "You can't remove your own lead access or turn off your own login" }, 400);
      const patch: any = {};
      if (body.display_name != null) { patch.display_name = String(body.display_name).trim(); patch.full_name = patch.display_name; }
      if (body.role != null) { if (!ROLES.has(body.role)) return json({ error: "Bad role" }, 400); patch.role = body.role; }
      if (body.person !== undefined) patch.person = body.person || null;
      if (body.active != null) patch.active = !!body.active;
      if (body.username != null) {
        const u = cleanUser(body.username);
        if (!okUser(u)) return json({ error: "Bad username" }, 400);
        const { data: taken } = await admin.from("profiles").select("id").ilike("username", u).neq("id", uid).maybeSingle();
        if (taken) return json({ error: "That username is already in use" }, 409);
        patch.username = u;
      }
      if (patch.username && patch.username !== prof.username) {
        const { data: au } = await admin.auth.admin.getUserById(uid);
        if ((au?.user?.email || "").endsWith("@" + DOMAIN)) {
          const { error: ee } = await admin.auth.admin.updateUserById(uid, { email: emailFor(patch.username), email_confirm: true } as any);
          if (ee) return json({ error: "Username change: " + ee.message }, 500);
        }
      }
      const { error } = await admin.from("profiles").update(patch).eq("id", uid);
      if (error) return json({ error: error.message }, 500);
      if (body.active != null) {
        await admin.auth.admin.updateUserById(uid, { ban_duration: body.active ? "none" : "876000h" } as any);
      }
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
