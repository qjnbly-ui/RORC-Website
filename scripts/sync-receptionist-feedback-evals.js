const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const destination = path.join(root, "tests", "fixtures", "receptionist-feedback-evals.json");
const supabaseUrl = String(process.env.SUPABASE_URL || "https://aedvuofiodtsgijcxyqx.supabase.co").replace(/\/+$/, "");
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

function apiHeaders() {
  if (!serviceKey) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY before syncing receptionist feedback evaluations.");
  const headers = { apikey: serviceKey };
  if (!serviceKey.startsWith("sb_secret_")) headers.Authorization = `Bearer ${serviceKey}`;
  return headers;
}

function toFixture(row) {
  return {
    id: row.id,
    phrase: row.caller_utterance,
    expectedBehavior: row.expected_behavior,
    expectedIntent: row.expected_intent || undefined,
    requiredPhrases: row.required_phrases || [],
    forbiddenPhrases: row.forbidden_phrases || [],
    issueCategory: row.issue_category,
  };
}

async function main() {
  const select = [
    "id", "caller_utterance", "expected_behavior", "expected_intent",
    "required_phrases", "forbidden_phrases", "issue_category",
  ].join(",");
  const response = await fetch(`${supabaseUrl}/rest/v1/rorc_receptionist_eval_cases?select=${select}&enabled=eq.true&order=created_at.asc`, {
    headers: apiHeaders(),
  });
  const rows = await response.json().catch(() => null);
  if (!response.ok) throw new Error(String(rows?.message || rows?.error || `Evaluation sync failed (${response.status}).`));
  fs.writeFileSync(destination, `${JSON.stringify((rows || []).map(toFixture), null, 2)}\n`);
  console.log(`Synced ${(rows || []).length} receptionist feedback evaluation cases.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { apiHeaders, toFixture };
