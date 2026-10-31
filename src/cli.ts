// Node.js の入口（全体設計 4.1）。アダプターを組み立ててオーケストレーターに渡し、出力をファイルに書く。解析の処理は持たない。
//
// 使い方: node dist/src/cli.js <リポジトリのディレクトリ> --out <出力先> [--alloy-jar <jar>] [--records <LLM の記録の置き場所>] [--view-role BUSINESS|IMPLEMENTATION]
// 終了コード: 0 = 最後まで回った（論点や曖昧さがあっても 0）、1 = 環境の故障、2 = 引数の誤り。
//
// このファイルは Itera 向けの bundle（index.ts から）に入らないので、node: のモジュールを静的に import してよい。
// 出力の書き出しは Itera OS の起動アプリと共通の関数（lib/write_outputs.ts）で行う。

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { CliAlloyAdapter } from "./adapters/CliAlloyAdapter.js";
import { NodeFsAdapter } from "./adapters/NodeFsAdapter.js";
import { readRepository } from "./adapters/NodeRepositoryReader.js";
import { RecordingLanguageModel } from "./adapters/RecordingLanguageModel.js";
import { runPipeline } from "./core/orchestrator.js";
import { withRoot } from "./lib/rooted_file_system.js";
import { writeOutputs } from "./lib/write_outputs.js";
import type { ViewRole } from "./types/projection.js";

export { safeName } from "./lib/write_outputs.js";

const USAGE =
  "使い方: node dist/src/cli.js <リポジトリのディレクトリ> --out <出力先> [--alloy-jar <jar>] [--records <LLM の記録の置き場所>] [--view-role BUSINESS|IMPLEMENTATION]";

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
  let viewRole: ViewRole;
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        out: { type: "string" },
        "alloy-jar": { type: "string" },
        records: { type: "string" },
        "view-role": { type: "string" },
      },
    });
    if (parsed.positionals.length !== 1) throw new Error("リポジトリのディレクトリを 1 つだけ指定する");
    if (parsed.values.out === undefined || parsed.values.out === "") throw new Error("--out が無い");
    // 役割の誤りは、ここで引数の誤りにする。そのまま渡すと俯瞰図の射影が UNSUPPORTED_FORMAT を投げ、環境の故障（1）と区別できないため。
    // 小文字で受け取ってよく、読むときに大文字へ戻す（全体仕様 4.5）。列挙に無い値は既定に読み替えずにエラーにする。
    const given = parsed.values["view-role"] ?? "business";
    const role = given.toUpperCase();
    if (role !== "BUSINESS" && role !== "IMPLEMENTATION") {
      throw new Error(`--view-role は business か implementation（${given} を受け取った）`);
    }
    repoDir = parsed.positionals[0] as string;
    outDir = parsed.values.out;
    alloyJar = parsed.values["alloy-jar"];
    recordsDir = parsed.values.records ?? join(outDir, "llm_records");
    viewRole = role;
  } catch (error) {
    io.stderr(`引数の誤り: ${messageOf(error)}`);
    io.stderr(USAGE);
    return 2;
  }

  try {
    const fs = new NodeFsAdapter();
    const repo = await readRepository(repoDir);
    const result = await runPipeline(
      repo,
      {
        fs: withRoot(fs, repoDir),
        llm: new RecordingLanguageModel(null, fs, recordsDir),
        solver: alloyJar === undefined ? null : new CliAlloyAdapter({ jarPath: alloyJar }),
      },
      { viewRole },
    );
    await writeOutputs(fs, outDir, result);
    io.stdout(JSON.stringify(result.report.totals));
    return 0;
  } catch (error) {
    io.stderr(`実行を止めた（環境の故障）: ${messageOf(error)}`);
    return 1;
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