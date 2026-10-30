// SpecProjector が書く Markdown（spec.md・matrix.md）をブロックの並びに分ける（SpecViewer 基本設計 6.4・6.6）。
// 純粋な関数。SpecProjector が出す記法（render_document.ts・render_matrix.ts）だけを扱う。
// 行の先頭の記号だけで種類を決め、行の中の書式（強調・インラインのコードなど）は解釈しない。
// LLM の文は必ず決まった前置きの後ろに置かれ、改行は空白にしてあるので、LLM の文がブロックの区切りに化けることはない（設計 6.6）。

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "quote"; text: string }
  | { kind: "code"; info: string; text: string };

const FENCE = /^(`{3,})(.*)$/;
const HEADING = /^(#{1,6}) (.*)$/;
const TABLE_SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/;
const BULLET = /^- (.*)$/;
const ORDERED = /^\d+\. (.*)$/;
const QUOTE = /^> ?(.*)$/;

/** 表の 1 行をセルに分ける（mdCell の逆）。`\` の付かない `|` で分け、`\|` を `|` に戻す。 */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  const pushList = (ordered: boolean, item: string): void => {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.kind === "list" && last.ordered === ordered) last.items.push(item);
    else blocks.push({ kind: "list", ordered, items: [item] });
  };

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      // 同じ長さの囲みの行で閉じる。閉じていなければ最後までをコードとする。
      while (i < lines.length && lines[i] !== marker) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", info: fence[2]!.trim(), text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i += 1;
      continue;
    }

    if (line.startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) {
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.startsWith("|")) {
        rows.push(tableCells(lines[i]!));
        i += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      blocks.push({ kind: "quote", text: quote[1]! });
      i += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      pushList(false, bullet[1]!);
      i += 1;
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered !== null) {
      pushList(true, ordered[1]!);
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // 段落。空行か、ほかの種類の行までを 1 つにする（SpecProjector の段落は 1 行ずつ空行で区切られている）。
    const body: string[] = [line];
    i += 1;
    while (i < lines.length && isParagraphLine(lines, i)) {
      body.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

function isParagraphLine(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  if (line.trim() === "") return false;
  if (FENCE.test(line) || HEADING.test(line) || QUOTE.test(line) || BULLET.test(line) || ORDERED.test(line)) return false;
  if (line.startsWith("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!)) return false;
  return true;
}