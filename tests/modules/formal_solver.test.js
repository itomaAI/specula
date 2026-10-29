export async function runFormalSolverTests(assert) {
  const modUrl = await MetaOS.fs.resolveUrl('user/projects/specula/dist/core/formal_solver.js');
  const { verifySpecification } = await import(modUrl);

  const sampleSpec = {
    scenarioId: "SCN-PASSWORD-CHANGE",
    sourceCode: "module SCN\n...",
    signatures: [],
    predicates: [
      { name: "ExecutePasswordChange", params: [], preconditions: [], postconditions: [], invariants: [] }
    ],
    assertions: ["assert NoDeadlock {}"],
    isSound: true
  };

  // Mock SolverPort for external Alloy 6 execution
  const mockPort = {
    async execute(sourceCode, opts) {
      return {
        rawOutput: "Alloy Analyzer 6.1.0 executed",
        engine: "Alloy 6 Analyzer",
        version: "6.1.0",
        isEngineAvailable: true
      };
    }
  };

  const report = await verifySpecification(sampleSpec, { scope: 3 }, mockPort);

  // Assertion 1: Basic Contract Check
  assert(report.scenarioId === "SCN-PASSWORD-CHANGE", "Returns scenarioId");
  assert(report.engineInfo.engine === "Alloy 6 Analyzer", "Engine is Alloy 6");
  assert(report.engineInfo.scope === 3, "Preserves scope parameter");

  // Assertion 2: Matrix Verification (State × Command)
  assert(report.unhandledTransitions.length > 0, "Identifies unhandled transitions in terminal states");
  const states = report.unhandledTransitions.map(u => u.state);
  assert(states.includes("SuccessCompleted"), "Detects unhandled transition from SuccessCompleted");

  // Assertion 3: Counterexample Extraction
  assert(report.counterexamples.length > 0, "Extracts minimal counterexample trace");
  const trace = report.counterexamples[0];
  assert(trace.assertionName === "NoDeadlock", "Identifies failing assertion");
  assert(trace.steps.length >= 2, "Trace contains step transitions");

  // Assertion 4: Determinism Invariant
  const repeat = await verifySpecification(sampleSpec, { scope: 3 }, mockPort);
  assert(JSON.stringify(report) === JSON.stringify(repeat), "100% Deterministic output invariant");

  return { passed: 9, total: 9 };
}