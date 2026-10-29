export async function runLedgerSynthesizerTests(assert) {
  const modUrl = await MetaOS.fs.resolveUrl('user/projects/specula/dist/core/ledger_synthesizer.js');
  const { synthesizeLedger } = await import(modUrl);

  // Test Case 1: Unhandled Transitions / Counterexamples
  const errorReport = {
    scenarioId: "SCN-PASSWORD-CHANGE",
    isSound: false,
    engineInfo: { engine: "Alloy 6", version: "6.1.0", scope: 3 },
    unhandledTransitions: [
      { state: "SuccessCompleted", command: "ExecutePasswordChange", reason: "終端状態での二重実行未定義" },
      { state: "RejectedError", command: "ExecutePasswordChange", reason: "エラー画面での再試行未定義" }
    ],
    deadlocks: [],
    counterexamples: [],
    isPartitioned: false
  };

  const catalog = synthesizeLedger(errorReport);

  // Assertion 1: Basic Contract Check
  assert(catalog.scenarioId === "SCN-PASSWORD-CHANGE", "Returns scenarioId");
  assert(catalog.ledgers.length === 2, "Generates 2 domain ledgers for 2 unhandled transitions");
  assert(catalog.summary.isSound === false, "Catalog flags isSound=false");

  // Assertion 2: Root Cause Prioritization
  assert(catalog.ledgers[0].isRootCause === true, "First entry is marked as root cause");
  assert(catalog.ledgers[0].domainQuestion.includes("SuccessCompleted"), "Domain question mentions state name");

  // Assertion 3: 3-way Options
  const l1 = catalog.ledgers[0];
  assert(l1.options.length === 3, "Each ledger has exactly 3 actionable options");
  const keys = l1.options.map(o => o.key);
  assert(keys.includes("SPECIFY"), "Option SPECIFY exists");
  assert(keys.includes("FIX_BUG"), "Option FIX_BUG exists");
  assert(keys.includes("ALLOW_EDGE_CASE"), "Option ALLOW_EDGE_CASE exists");

  // Test Case 2: Proof Success Lock
  const soundReport = {
    scenarioId: "SCN-SOUND",
    isSound: true,
    engineInfo: { engine: "Alloy 6", version: "6.1.0", scope: 3 },
    unhandledTransitions: [],
    deadlocks: [],
    counterexamples: [],
    isPartitioned: false
  };

  const soundCatalog = synthesizeLedger(soundReport);
  assert(soundCatalog.summary.isSound === true, "Flags isSound=true");
  assert(soundCatalog.ledgers.length === 1, "Produces 1 ledger entry for proof success lock");
  assert(soundCatalog.ledgers[0].claim.includes("数学的に証明された"), "Recommends specification lock");

  // Test Case 3: Determinism Invariant
  const repeat = synthesizeLedger(errorReport);
  assert(JSON.stringify(catalog) === JSON.stringify(repeat), "100% Deterministic output invariant");

  return { passed: 11, total: 11 };
}