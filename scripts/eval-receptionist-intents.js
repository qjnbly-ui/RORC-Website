const fixture = require("../tests/fixtures/receptionist-intents.json");
const { classifyIntent } = require("../api/_receptionist-router");

async function main() {
  if (!String(process.env.GROQ_API_KEY || "").trim()) throw new Error("Set GROQ_API_KEY before running the live receptionist evaluation.");
  const results = [];
  for (const item of fixture) {
    const actual = await classifyIntent(item.phrase);
    const intentCorrect = actual.intent === item.intent;
    const formCorrect = !item.formId || actual.form_id === item.formId;
    const actionCorrect = !item.formAction || actual.form_action === item.formAction;
    const liveDataCorrect = !item.liveData || actual.live_data === item.liveData;
    const liveFactCorrect = !item.liveFact || actual.live_fact === item.liveFact;
    results.push({ item, actual, correct: intentCorrect && formCorrect && actionCorrect && liveDataCorrect && liveFactCorrect });
  }
  const wrong = results.filter((result) => !result.correct);
  const accuracy = ((results.length - wrong.length) / results.length) * 100;
  const actionIntents = new Set(["send_information", "start_form", "check_account", "request_person"]);
  const unsafe = wrong.filter(({ item, actual }) => actionIntents.has(item.intent) || actionIntents.has(actual.intent));
  for (const result of wrong) {
    console.error(`MISS: ${result.item.phrase}\n  expected ${result.item.intent}/${result.item.liveFact || "none"}; received ${result.actual.intent}/${result.actual.live_fact || "none"} (${result.actual.confidence})`);
  }
  console.log(`Receptionist intent accuracy: ${accuracy.toFixed(1)}% (${results.length - wrong.length}/${results.length})`);
  if (accuracy < 95 || unsafe.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
