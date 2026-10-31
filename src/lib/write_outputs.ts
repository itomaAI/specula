// 実行の結果をファイルに書く（全体設計 4.1 の「出力の置き方」）。
// Node.js のコマンドラインと Itera OS の起動アプリの両方から使うので、FileSystemPort だけを通し、node:path を使わない。
// パスは "/" でつなぐ（NodeFsAdapter は Windows でも "/" を受け付ける）。

import type { FileSystemPort } from "../ports/FileSystemPort.js";
import { viewsDirOf } from "../types/projection.js";
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
  // 辞書と意図の候補は内部の記録、対応表は表示の id から実装を引く表。どれも実装の名前を含み、表示の役割で中身を変えない（全体設計 2.2・4.1）。
  await put(at("glossary.json"), json(result.glossary));
  await put(at("intents.json"), json(result.intents));
  await put(at("implementation_map.json"), json(result.implementationMap));
  for (const commandTarget of result.commands) {
    const dir = at("commands", safeName(commandTarget.commandId));
    if (commandTarget.kind === "COMPLETED") {
      await put(`${dir}/spec.json`, json(commandTarget.spec));
      await put(`${dir}/spec.als`, commandTarget.spec.source.endsWith("\n") ? commandTarget.spec.source : commandTarget.spec.source + "\n");
      await put(`${dir}/solver_report.json`, json(commandTarget.solverReport));
      await put(`${dir}/ledger.json`, json(commandTarget.ledger));
    } else if (commandTarget.kind === "AMBIGUOUS") {
      await put(`${dir}/ambiguity.json`, json(commandTarget.ambiguity));
    }
  }

  // 利用者向けの出力は役割で中身が変わるので、両方の役割の分を views/<役割>/ の下に、上と同じ相対パスで書く（全体設計 4.1）。
  for (const views of result.views) {
    const base = viewsDirOf(views.viewRole);
    await put(at(base, "system_map.mmd"), views.system.mermaid.content);
    // 地図 1 と Bounded Context ごとの地図 2 を束ねた俯瞰図。
    await put(at(base, "system_map.json"), json(views.system.json));
    for (const commandViews of views.commands) {
      const dir = at(base, "commands", safeName(commandViews.commandId));
      if (commandViews.kind === "COMPLETED") {
        await put(`${dir}/spec.md`, commandViews.document.content);
        await put(`${dir}/matrix.md`, commandViews.matrix.content);
        await put(`${dir}/flow.mmd`, commandViews.flow.content);
      } else {
        await put(`${dir}/ambiguity.md`, commandViews.view.content);
      }
    }
  }
  return written;
}