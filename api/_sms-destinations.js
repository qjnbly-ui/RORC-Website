function parseSmsDestinations(value, fallback = "") {
  const raw = String(value || "").trim() || String(fallback || "").trim();
  const destinations = [...new Set(
    raw
      .split(",")
      .map((destination) => destination.trim())
      .filter(Boolean)
  )];

  if (!destinations.length) {
    throw new Error("At least one SMS destination is required.");
  }

  const invalid = destinations.filter((destination) => !/^\+[1-9]\d{7,14}$/.test(destination));
  if (invalid.length) {
    throw new Error(`Invalid SMS destination${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}. Use + followed by the country code and number.`);
  }

  return destinations;
}

module.exports = { parseSmsDestinations };
