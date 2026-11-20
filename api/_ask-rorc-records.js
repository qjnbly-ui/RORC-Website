const base = (process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");

async function recordsFor(req, token) {
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const headers = { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${token}` };
  async function read(path, options = {}) {
    const response = await fetch(`${base}/rest/v1/${path}`, {
      headers, signal: AbortSignal.timeout(5000), ...options
    });
    if (!response.ok) throw new Error("Record lookup unavailable");
    return response;
  }
  const choices = await (await read("rpc/list_my_accounts", { method: "POST", body: "{}" })).json();
  const selected = req.headers["x-rorc-account-member"];
  const choice = selected ? choices.find(row => row.account_member_id === selected) : choices.find(row => row.is_primary);
  if (!choice && selected) throw Object.assign(new Error("Selected account unavailable"), {status: 403});
  if (!choice) return { datasets: [], manager: false };
  const id = encodeURIComponent(choice.account_member_id);
  headers["x-rorc-account-member"] = choice.account_member_id;
  const profile = (await (await read(`account_member_profiles?select=account_type,member_name,membership_details,expiration_date,allow_guest_entry,allow_heater_use&account_member_id=eq.${id}&limit=1`)).json())[0];
  if (!profile || profile.account_type === "Kiosk Account") return { datasets: [], manager: false };
  const manager = choice.is_primary === true && profile.account_type === "Account Manager";
  const sources = {
    bookings: ["rental_requests", "event_name,event_date,event_start_time,rental_status,payment_status", "event_date.desc", `claimed_account_id=eq.${encodeURIComponent(choice.account_id)}`],
    visits: ["timesheet_entries", "signed_in_at,signed_out_at,member_or_guest", "signed_in_at.desc", `member_id=eq.${id}`],
    thermostat: ["heater_use_entries", "system_type,start_at,end_at,paid", "start_at.desc", `responsible_member_id=eq.${id}`],
    charges: ["billing_line_items", "reason,amount_cents,payment_recorded_at,created_at", "created_at.desc", `account_member_id=eq.${id}`]
  };
  if (manager) sources.sponsorships = ["sponsor_banners", "name,status", "name.asc", ""];
  return {
    manager, datasets: ["membership", ...Object.keys(sources)],
    async lookup({ dataset, scope = "own" }) {
      if (!["own", "center"].includes(scope) || (scope === "center" && !manager)) return { error: "Access unavailable" };
      if (dataset === "membership") return scope === "own" ? profile : { error: "Membership lookup is personal" };
      if (!Object.hasOwn(sources, dataset) || (dataset === "sponsorships" && scope !== "center")) return { error: "Dataset unavailable" };
      const [table, fields, order, filter] = sources[dataset];
      const requestHeaders = { ...headers, Prefer: "count=exact" };
      // The sponsor registry uses the same primary-manager gate as its dashboard API.
      if (dataset === "sponsorships") {
        requestHeaders.apikey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        requestHeaders.Authorization = `Bearer ${requestHeaders.apikey}`;
      }
      const response = await read(`${table}?select=${fields}&order=${order}&limit=40${scope === "own" ? "&" + filter : ""}`, {headers: requestHeaders});
      const total = response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
      return { dataset, scope, total: total == null ? null : Number(total), rows: await response.json(), limit: 40, order };
    }
  };
}
module.exports = { recordsFor };
