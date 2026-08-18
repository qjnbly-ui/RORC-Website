async function runAutomationStep({ req, completedSteps, step, action }) {
  if (completedSteps.has(step)) return;
  const hooks = req.automationHooks || {};
  await hooks.beforeStep?.(step, [...completedSteps]);
  try {
    await action();
    completedSteps.add(step);
    await hooks.afterStep?.(step, [...completedSteps]);
  } catch (error) {
    error.completedSteps = [...completedSteps];
    error.inFlightStep = step;
    throw error;
  }
}

module.exports = { runAutomationStep };
