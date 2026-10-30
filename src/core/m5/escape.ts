// 描画で使う置き換え（M5 の設計 4.1・4.2・4.3・3.6）。

/** Markdown の表のセル: `|` を `\|` に、改行を空白に置き換える（設計 4.2）。 */
export function mdCell(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|");
}

/** Markdown の本文の 1 行: 改行を空白に置き換える（LLM の文を箇条書きの 1 項目に収めるため）。 */
export function mdLine(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Mermaid のノードの文: `["…"]` の中に置く。`"` を `#quot;`、改行を空白に置き換える（設計 4.3）。
 * `<`・`>` も `#lt;`・`#gt;` にする。表示名に HTML のタグに見える文字があっても図が壊れないようにするため。
 */
export function mermaidLabel(text: string): string {
  const body = text
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;");
  return `["${body}"]`;
}

/** 形式仕様のソースから `-- @source:` の行を取り除く（M2 は各要素の直上の 1 行に書く。設計 2 の表）。 */
export function stripSourceComments(source: string): string {
  return source
    .split(/\r\n|\r|\n/)
    .filter((line) => !/^\s*--\s*@source:/.test(line))
    .join("\n");
}

/** コードの囲みの記号: ソースの中の最も長いバッククォートの並びより 1 つ長くする（最低 3 つ）。 */
export function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** 行の配列をつなぎ、末尾を改行 1 つで終える（設計 3.6）。 */
export function joinLines(lines: string[]): string {
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}