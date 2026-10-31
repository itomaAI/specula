// 表示の役割が IMPLEMENTATION のときの、実装の名前と所在の併記（SpecProjector の設計 8.3）。
//
// 併記の中身は辞書の項目の implementation をそのまま使う。実装との対応表（設計 8.5）も同じ値を写すので、
// 表と表示が食い違わない。BUSINESS のときは呼ばない（呼び出し元が役割で分ける）。
//
// - Markdown: 「（`<ファイル>#<関数>` L<行>、…）」。関数か行が無いときは、その部分を省く。
// - Mermaid: 「 / <ファイル>#<関数>、…」。行は書かない（ノードの文を短く保つため）。置き換えは呼び出し元の mermaidLabel が行う。
// 所在が 1 つも無いときは、どちらも空の文字列を返す（併記しない）。

import type { GlossaryLocation } from "../../types/glossary.js";

/** インラインコード: 中の最も長いバッククォートの並びより 1 つ長い記号で囲む。 */
export function codeSpan(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  // 中身がバッククォートで始まるか終わるときは、空白を挟む（CommonMark の規則）。
  const body = text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text;
  return `${fence}${body}${fence}`;
}

function placeOf(location: GlossaryLocation): string {
  return location.symbol === undefined ? location.file : `${location.file}#${location.symbol}`;
}

/** Markdown の文の後ろに足す併記。所在が無ければ ""。 */
export function markdownImplementationNote(locations: readonly GlossaryLocation[]): string {
  if (locations.length === 0) return "";
  const parts = locations.map((location) =>
    location.line === undefined ? codeSpan(placeOf(location)) : `${codeSpan(placeOf(location))} L${location.line}`,
  );
  return `（${parts.join("、")}）`;
}

/** Mermaid のノードの文の後ろに足す併記。所在が無ければ ""。 */
export function mermaidImplementationNote(locations: readonly GlossaryLocation[]): string {
  if (locations.length === 0) return "";
  return ` / ${locations.map(placeOf).join("、")}`;
}