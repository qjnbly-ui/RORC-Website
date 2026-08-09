async function hasCurrentFacilityOccupancy({
  supabaseUrl,
  serviceRoleKey,
  fetcher = fetch
}) {
  const baseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
  const key = String(serviceRoleKey || "").trim();

  if (!baseUrl || !key) {
    throw new Error("Supabase service access is not configured.");
  }

  const params = new URLSearchParams({
    select: "id",
    signed_out_at: "is.null",
    limit: "1"
  });
  const response = await fetcher(`${baseUrl}/rest/v1/timesheet_entries?${params.toString()}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not check facility occupancy: ${response.status} ${text}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("Could not check facility occupancy: invalid response.");
  }
  return rows.length > 0;
}

module.exports = {
  hasCurrentFacilityOccupancy
};
