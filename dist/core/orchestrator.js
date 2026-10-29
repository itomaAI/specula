











import { extractScenarios } from './scenario_extractor.js';
import { extractContext } from './context_extractor.js';
import { transpileFormal } from './formal_transpiler.js';
import { verifySpecification } from './formal_solver.js';
import { synthesizeLedger } from './ledger_synthesizer.js';
import { projectSpecification } from './spec_projector.js';





















/**
 * Specula E2E Orchestrator
 * Pure ESM, Zero-I/O Core.
 * Executes the complete 6-stage pipeline (M0 ➔ M1 ➔ M2 ➔ M3 ➔ M4 ➔ M5).
 */
export async function executePipeline(
  repo,
  options
) {
  // Stage 1: M0 ScenarioExtractor (Event Storming & Scenario Slicing)
  const { map, scenarios } = extractScenarios(repo);

  const targets = options?.targetScenarioId
    ? scenarios.filter(s => s.id === options.targetScenarioId)
    : scenarios;

  const executions = [];
  let soundCount = 0;
  let ambiguityCount = 0;

  for (const target of targets) {
    // Stage 2: M1 ContextExtractor (Vertical Causal Slicing within Boundaries)
    const context = extractContext(target, repo);

    // Stage 3: M2 FormalTranspiler (Domain Vocabulary & Alloy 6 Synthesis)
    const transpileResult = transpileFormal(context);

    if (transpileResult.kind === 'AMBIGUITY') {
      ambiguityCount++;
      executions.push({
        target,
        context,
        transpileResult
      });
      continue;
    }

    const spec = transpileResult.spec;

    // Stage 4: M3 FormalSolver (State Matrix Verification & Counterexample Discovery)
    const solverReport = await verifySpecification(spec, { scope: options?.scope || 3 });

    // Stage 5: M4 LedgerSynthesizer (Decision Questions & Root-Cause Extraction)
    const ledgerCatalog = synthesizeLedger(solverReport, spec);

    // Stage 6: M5 SpecProjector (Multi-view Deterministic Projection)
    const views = projectSpecification(spec, ledgerCatalog);

    if (solverReport.isSound) soundCount++;

    executions.push({
      target,
      context,
      transpileResult,
      solverReport,
      ledgerCatalog,
      views
    });
  }

  return {
    map,
    executions,
    summary: {
      totalScenarios: targets.length,
      soundCount,
      ambiguityCount,
      isAllSound: soundCount === targets.length && ambiguityCount === 0
    }
  };
}