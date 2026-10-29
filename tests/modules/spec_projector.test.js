export async function runSpecProjectorTests(assert) {
  const modUrl = await MetaOS.fs.resolveUrl('user/projects/specula/dist/core/spec_projector.js');
  const { projectSpecification } = await import(modUrl);

  const sampleSpec = {
    scenarioId: "SCN-PASSWORD-CHANGE",
    sourceCode: "module SCN\n...",
    signatures: [
      { name: "ScreenState", isVar: false, isAbstract: true, fields: [] },
      { name: "CurrentState", isVar: true, isAbstract: false, fields: [] },
      { name: "User", isVar: false, isAbstract: false, fields: [{ name: "id", type: "String", multiplicity: "one" }] }
    ],
    predicates: [
      {
        name: "ExecutePasswordChange",
        params: [],
        preconditions: ["CurrentState in InitialReady"],
        postconditions: ["CurrentState' in SuccessCompleted"],
        invariants: ["actor.id' = actor.id"]
      }
    ],
    assertions: ["assert NoDeadlock {}"],
    isSound: true
  };

  const sampleLedger = {
    scenarioId: "SCN-PASSWORD-CHANGE",
    ledgers: [
      {
        id: "LEDGER-001",
        scenarioId: "SCN-PASSWORD-CHANGE",
        isRootCause: true,
        claim: "状態遷移の完全性",
        observation: "検証完了",
        domainQuestion: "仕様をロックしますか？",
        options: [{ key: "SPECIFY", label: "ロック承認", description: "正本化する" }]
      }
    ],
    summary: { totalIssues: 1, rootCausesCount: 1, isSound: true }
  };

  const views = projectSpecification(sampleSpec, sampleLedger);

  // Assertion 1: Basic View Object
  assert(views.scenarioId === "SCN-PASSWORD-CHANGE", "Returns scenarioId");

  // Assertion 2: Markdown Spec Projection
  assert(views.markdownDoc.includes("# 仕様書: SCN-PASSWORD-CHANGE"), "Generates Markdown H1 title");
  assert(views.markdownDoc.includes("ExecutePasswordChange"), "Contains predicate in markdown");
  assert(views.markdownDoc.includes("LEDGER-001"), "Includes ledger catalog in markdown");

  // Assertion 3: DAG JSON Projection
  assert(views.dagJson !== undefined, "Produces dagJson object");
  assert(views.dagJson.nodes.length >= 3, "Contains graph nodes");
  assert(views.dagJson.edges.length >= 2, "Contains graph edges");

  // Assertion 4: Mermaid Sequence Diagram
  assert(views.mermaidDiagram.startsWith("sequenceDiagram"), "Produces Mermaid sequence diagram");
  assert(views.mermaidDiagram.includes("ExecutePasswordChange"), "Contains operation in sequence diagram");

  // Assertion 5: State Matrix Markdown Table
  assert(views.stateMatrixMd.includes("現在状態 \\ 操作"), "Produces state matrix markdown table");
  assert(views.stateMatrixMd.includes("InitialReady"), "Contains state row");

  // Assertion 6: Determinism Invariant (diff = 0)
  const repeat = projectSpecification(sampleSpec, sampleLedger);
  assert(views.markdownDoc === repeat.markdownDoc, "100% Deterministic: Markdown diff = 0");
  assert(JSON.stringify(views.dagJson) === JSON.stringify(repeat.dagJson), "100% Deterministic: DAG diff = 0");
  assert(views.mermaidDiagram === repeat.mermaidDiagram, "100% Deterministic: Mermaid diff = 0");
  assert(views.stateMatrixMd === repeat.stateMatrixMd, "100% Deterministic: Matrix diff = 0");

  return { passed: 13, total: 13 };
}