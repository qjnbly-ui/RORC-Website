async function hasActiveThermostatRuntime({
  supabaseUrl,
  serviceRoleKey,
  systemType
}) {
  const baseUrl = String(supabaseUrl || "").replace(/\/+$/, "");
  const key = String(serviceRoleKey || "").trim();
  const normalizedSystemType = String(systemType || "").trim().toLowerCase();

  if (!baseUrl || !key) {
    throw new Error("Supabase service access is not configured.");
  }
  if (!["heat", "ac"].includes(normalizedSystemType)) {
    throw new Error("A valid thermostat system type is required.");
  }

  const params = new URLSearchParams({
    select: "id",
    system_type: `eq.${normalizedSystemType}`,
    turn_heater_on: "eq.On",
    start_at: "not.is.null",
    end_at: "is.null",
    limit: "1"
  });
  const response = await fetch(`${baseUrl}/rest/v1/heater_use_entries?${params.toString()}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Could not check active thermostat runtime: ${response.status} ${text}`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) {
    throw new Error("Could not check active thermostat runtime: invalid response.");
  }
  return rows.length > 0;
}

module.exports = {
  hasActiveThermostatRuntime
};
