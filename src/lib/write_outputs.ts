// 実行の結果をファイルに書く（全体設計 4.1 の「出力の置き方」）。
// Node.js のコマンドラインと Itera OS の起動アプリの両方から使うので、FileSystemPort だけを通し、node:path を使わない。
// パスは "/" でつなぐ（NodeFsAdapter は Windows でも "/" を受け付ける）。

import type { FileSystemPort } from "../ports/FileSystemPort.js";
import type { PipelineResult } from "../types/run.js";

/** 英数字・"-"・"_"・"." 以外を "_" にする。 */
export function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 書いたファイルのパスを返す（起動アプリが進み具合に出せるように）。 */
export async function writeOutputs(fs: FileSystemPort, outDir: string, result: PipelineResult): Promise<string[]> {
  const root = outDir.replace(/\/+$/, "");
  const at = (...parts: string[]): string => [root, ...parts].filter((p) => p !== "").join("/");
  const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
  const written: string[] = [];
  const put = async (path: string, content: string): Promise<void> => {
    await fs.write(path, content);
    written.push(path);
  };

  await put(at("run_report.json"), json(result.report));
  await put(at("system_map.mmd"), result.systemViews.mermaid.content);
  await put(at("system_map.json"), result.systemViews.json.content);
  for (const scenario of result.scenarios) {
    const dir = at("scenarios", safeName(scenario.scenarioId));
    if (scenario.kind === "COMPLETED") {
      await put(`${dir}/spec.json`, json(scenario.spec));
      await put(`${dir}/spec.als`, scenario.spec.source.endsWith("\n") ? scenario.spec.source : scenario.spec.source + "\n");
      await put(`${dir}/solver_report.json`, json(scenario.solverReport));
      await put(`${dir}/ledger.json`, json(scenario.ledger));
      await put(`${dir}/spec.md`, scenario.document.content);
      await put(`${dir}/matrix.md`, scenario.matrix.content);
      await put(`${dir}/flow.mmd`, scenario.flow.content);
    } else if (scenario.kind === "AMBIGUOUS") {
      await put(`${dir}/ambiguity.json`, json(scenario.ambiguity));
    }
  }
  return written;
}