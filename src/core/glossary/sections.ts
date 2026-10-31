// Step 1: SectionSplitter（GlossaryBuilder の設計 3.1）。資料を節に分ける。LLM を使わない。
//
// - README・DOC は Markdown の見出し（行頭の # 1〜6 個と空白）で分ける。コードの囲み（``` か ~~~ で始まる行から、
//   同じ印で始まる行まで）の中の # は見出しにしない。最初の見出しより前の本文は、見出しの無い節にする（空白だけなら作らない）。
// - SCHEMA はファイル全体を 1 つの節にする。
// - 識別子は "<資料のパス>#<見出しの並び>"（上位から " > " でつなぐ。見出しの無い節は "<資料のパス>#"）。
//   同じ識別子が 2 つ以上あれば、2 つ目から出現順に " (2)"、" (3)" を足す。
// - 本文は見出しの行を含め、次の見出しの直前まで。

import type { RepositoryDocument } from "../../types/command.js";

export interface DocumentSection {
  id: string;
  /** 資料のパス。 */
  document: string;
  kind: RepositoryDocument["kind"];
  text: string;
}

const HEADING = /^(#{1,6})[ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;

export function splitSections(documents: readonly RepositoryDocument[]): DocumentSection[] {
  const sections: DocumentSection[] = [];
  for (const document of documents) {
    if (document.kind === "SCHEMA") {
      sections.push({ id: `${document.path}#`, document: document.path, kind: document.kind, text: document.text });
      continue;
    }
    sections.push(...splitMarkdown(document));
  }
  return sections;
}

function splitMarkdown(document: RepositoryDocument): DocumentSection[] {
  const drafts: Array<{ base: string; lines: string[] }> = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: { base: string; lines: string[] } = { base: `${document.path}#`, lines: [] };
  let fence: string | null = null;

  for (const line of document.text.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      current.lines.push(line);
      continue;
    }
    const heading = fence === null ? HEADING.exec(line) : null;
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    drafts.push(current);
    const level = (heading[1] ?? "").length;
    const title = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
    stack.push({ level, title });
    current = { base: `${document.path}#${stack.map((h) => h.title).join(" > ")}`, lines: [line] };
  }
  drafts.push(current);

  const seen = new Map<string, number>();
  const sections: DocumentSection[] = [];
  for (const [index, draft] of drafts.entries()) {
    const text = draft.lines.join("\n");
    // 見出しより前の本文（先頭の下書き）は、空白だけなら節にしない。
    if (index === 0 && text.trim() === "") continue;
    const count = (seen.get(draft.base) ?? 0) + 1;
    seen.set(draft.base, count);
    sections.push({
      id: count === 1 ? draft.base : `${draft.base} (${count})`,
      document: document.path,
      kind: document.kind,
      text,
    });
  }
  return sections;
}