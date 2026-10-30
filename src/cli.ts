// Node.js の入口（全体設計 4.1）。アダプターを組み立ててオーケストレーターに渡し、出力をファイルに書く。解析の処理は持たない。
//
// 使い方: node dist/src/cli.js <リポジトリのディレクトリ> --out <出力先> [--alloy-jar <jar>] [--records <LLM の記録の置き場所>]
// 終了コード: 0 = 最後まで回った（論点や曖昧さがあっても 0）、1 = 環境の故障、2 = 引数の誤り。
//
// このファイルは Itera 向けの bundle（index.ts から）に入らないので、node: のモジュールを静的に import してよい。

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CliAlloyAdapter } from "./adapters/CliAlloyAdapter.js";
import { NodeFsAdapter } from "./adapters/NodeFsAdapter.js";
import { readRepository } from "./adapters/NodeRepositoryReader.js";
import { RecordingLanguageModel } from "./adapters/RecordingLanguageModel.js";
import { runPipeline } from "./core/orchestrator.js";
import { withRoot } from "./lib/rooted_file_system.js";
import type { PipelineResult } from "./types/run.js";

const USAGE =
  "使い方: node dist/src/cli.js <リポジトリのディレクトリ> --out <出力先> [--alloy-jar <jar>] [--records <LLM の記録の置き場所>]";

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: CliIo = {
  stdout: (line) => process.stdout.write(line + "\n"),
  stderr: (line) => process.stderr.write(line + "\n"),
};

export async function main(argv: readonly string[], io: CliIo = DEFAULT_IO): Promise<number> {
  let repoDir: string;
  let outDir: string;
  let alloyJar: string | undefined;
  let recordsDir: string;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: "string" },
        "alloy-jar": { type: "string" },
        records: { type: "string" },
      },
    });
    if (parsed.positionals.length !== 1) throw new Error("リポジトリのディレクトリを 1 つだけ指定する");
    if (parsed.values.out === undefined || parsed.values.out === "") throw new Error("--out が無い");
    repoDir = parsed.positionals[0] as string;
    outDir = parsed.values.out;
    alloyJar = parsed.values["alloy-jar"];
    recordsDir = parsed.values.records ?? join(outDir, "llm_records");
  } catch (error) {
    io.stderr(`引数の誤り: ${messageOf(error)}`);
    io.stderr(USAGE);
    return 2;
  }

  try {
    const fs = new NodeFsAdapter();
    const repo = await readRepository(repoDir);
    const result = await runPipeline(repo, {
      fs: withRoot(fs, repoDir),
      llm: new RecordingLanguageModel(null, fs, recordsDir),
      solver: alloyJar === undefined ? null : new CliAlloyAdapter({ jarPath: alloyJar }),
    });
    await writeOutputs(fs, outDir, result);
    io.stdout(JSON.stringify(result.report.totals));
    return 0;
  } catch (error) {
    io.stderr(`実行を止めた（環境の故障）: ${messageOf(error)}`);
    return 1;
  }
}

/** 英数字・"-"・"_"・"." 以外を "_" にする。 */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function writeOutputs(fs: NodeFsAdapter, outDir: string, result: PipelineResult): Promise<void> {
  const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
  await fs.write(join(outDir, "run_report.json"), json(result.report));
  await fs.write(join(outDir, "system_map.mmd"), result.systemViews.mermaid.content);
  await fs.write(join(outDir, "system_map.json"), result.systemViews.json.content);
  for (const scenario of result.scenarios) {
    const dir = join(outDir, "scenarios", safeName(scenario.scenarioId));
    if (scenario.kind === "COMPLETED") {
      await fs.write(join(dir, "spec.json"), json(scenario.spec));
      await fs.write(join(dir, "spec.als"), scenario.spec.source.endsWith("\n") ? scenario.spec.source : scenario.spec.source + "\n");
      await fs.write(join(dir, "solver_report.json"), json(scenario.solverReport));
      await fs.write(join(dir, "ledger.json"), json(scenario.ledger));
      await fs.write(join(dir, "spec.md"), scenario.document.content);
      await fs.write(join(dir, "matrix.md"), scenario.matrix.content);
      await fs.write(join(dir, "flow.mmd"), scenario.flow.content);
    } else if (scenario.kind === "AMBIGUOUS") {
      await fs.write(join(dir, "ambiguity.json"), json(scenario.ambiguity));
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// スクリプトとして実行されたときだけ動かす（テストからは main を直接呼ぶ）。
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  process.exitCode = await main(process.argv.slice(2));
}