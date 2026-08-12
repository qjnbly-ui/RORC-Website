const fixture = require("../tests/fixtures/receptionist-feedback-evals.json");
const { answer } = require("../api/receptionist/conversation");
const { classifyIntent } = require("../api/_receptionist-router");

function normalized(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreAnswerCase(item, result = {}) {
  const reply = normalized(result.reply);
  const missing = (item.requiredPhrases || []).filter((phrase) => !reply.includes(normalized(phrase)));
  const forbidden = (item.forbiddenPhrases || []).filter((phrase) => reply.includes(normalized(phrase)));
  const intentCorrect = !item.expectedIntent || result.intent === item.expectedIntent;
  return { correct: intentCorrect && !missing.length && !forbidden.length, intentCorrect, missing, forbidden };
}

async function runCase(item) {
  const route = await classifyIntent(item.phrase);
  const needsAnswer = (item.requiredPhrases || []).length || (item.forbiddenPhrases || []).length;
  const reply = needsAnswer
    ? await answer(item.phrase, [], route.intent === "detailed_explanation" ? "detailed" : "brief", route)
    : "";
  return { route, reply, score: scoreAnswerCase(item, { intent: route.intent, reply }) };
}

async function main() {
  if (!fixture.length) {
    console.log("No approved receptionist feedback evaluation cases have been synced yet.");
    return;
  }
  if (!String(process.env.GROQ_API_KEY || "").trim()) {
    throw new Error("Set GROQ_API_KEY before running receptionist feedback evaluations.");
  }
  const failures = [];
  for (const item of fixture) {
    const result = await runCase(item);
    if (!result.score.correct) failures.push({ item, result });
  }
  for (const { item, result } of failures) {
    console.error(`MISS: ${item.phrase}\n  expected: ${item.expectedBehavior}\n  received intent: ${result.route.intent}\n  received answer: ${result.reply || "(not evaluated)"}`);
  }
  const accuracy = ((fixture.length - failures.length) / fixture.length) * 100;
  console.log(`Receptionist feedback evaluation accuracy: ${accuracy.toFixed(1)}% (${fixture.length - failures.length}/${fixture.length})`);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { normalized, runCase, scoreAnswerCase };
