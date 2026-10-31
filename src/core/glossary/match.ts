// Step 3: SectionMatcher（GlossaryBuilder の設計 3.3）。提示する項目ごとに、手がかりで資料の節を選ぶ。LLM を使わない。
//
// - 手がかり: 実装から機械的に決まる文字列。BOUNDED_CONTEXT は根のディレクトリの名前、COMMAND はハンドラの関数名と
//   ファイル名（拡張子を除く）、EVENT はハンドラの関数名・ファイル名・シグナルの label、POLICY はイベントの名前・
//   登録の関数名・起動される関数名。DEFAULT_CONTEXT は手がかりを持たない。
// - 照合: 手がかりが節の本文に 1 つの語として現れるか（語の境目は英字・数字・_・- 以外の文字か本文の端）。
//   大文字小文字は区別しない。識別子を語に分けない。
// - 選択: 一致した手がかりの種類の数が多い順、同じなら節の識別子の辞書順で上位 3 節。抜粋は先頭の 1500 字まで。

import type { EventStormingMap } from "../../types/scenario.js";
import { DEFAULT_CONTEXT_ID, compareIds } from "../m0/boundary.js";
import type { DocumentSection } from "./sections.js";

export const MAX_SECTIONS = 3;
export const EXCERPT_CHARS = 1500;
/** 意味（資料の抜粋）の上限の字数（設計 5.3）。 */
export const MEANING_CHARS = 400;
/** コードの囲みの開始の行。1 つ目は囲みの印（sections.ts と同じ ``` か ~~~）、2 つ目は言語の名前（無ければ空）。 */
const CODE_FENCE = /^ {0,3}(```|~~~)[`~]*[ \t]*([^\s`~]*)/;
/**
 * 意味の抜粋で飛ばすソースコードの言語の名前（小文字。Q5）。仕様の記法（alloy・mermaid・gherkin など）と、
 * スキーマや設定の形（graphql・json・yaml など）は入れない。
 */
export const SOURCE_CODE_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript", "ts", "tsx", "javascript", "js", "jsx", "mjs", "cjs",
  "python", "py", "java", "kotlin", "kt", "go", "rust", "rs",
  "c", "cpp", "c++", "csharp", "cs", "ruby", "rb", "php", "swift", "scala",
  "shell", "sh", "bash", "zsh", "powershell", "ps1", "sql",
]);

export interface SelectedSection {
  section: string;
  document: string;
  text: string;
  truncated: boolean;
}

/** 提示する項目ごとの手がかり（種類 → 値）。 */
export function cluesOf(map: EventStormingMap): Map<string, Map<string, string>> {
  const clues = new Map<string, Map<string, string>>();
  const put = (id: string, values: Record<string, string | null | undefined>): void => {
    const entry = new Map<string, string>();
    for (const [kind, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") entry.set(kind, value);
    clues.set(id, entry);
  };
  for (const context of map.boundedContexts) {
    put(context.id, context.id === DEFAULT_CONTEXT_ID ? {} : { root: context.name });
  }
  for (const command of map.commands) {
    put(command.id, { symbol: command.handler.symbol, file: baseNameOf(command.handler.file) });
  }
  for (const event of map.events) {
    put(event.id, { symbol: event.handler.symbol, file: baseNameOf(event.handler.file), label: event.signal.label });
  }
  const eventById = new Map(map.events.map((event) => [event.id, event] as const));
  const commandById = new Map(map.commands.map((command) => [command.id, command] as const));
  for (const policy of map.policies) {
    put(policy.id, {
      event: eventById.get(policy.triggerEventId)?.signal.label,
      listener: policy.listener.symbol,
      target: commandById.get(policy.actionCommandId)?.handler.symbol,
    });
  }
  return clues;
}

export function selectSections(
  clues: ReadonlyMap<string, ReadonlyMap<string, string>>,
  sections: readonly DocumentSection[],
): Map<string, SelectedSection[]> {
  const lowered = sections.map((section) => ({ section, text: section.text.toLowerCase() }));
  const selected = new Map<string, SelectedSection[]>();
  for (const [entryId, entryClues] of clues) {
    const values = [...entryClues.values()].map((value) => value.toLowerCase());
    const scored = lowered
      .map(({ section, text }) => ({ section, score: values.filter((value) => containsWord(text, value)).length }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || compareIds(a.section.id, b.section.id))
      .slice(0, MAX_SECTIONS);
    selected.set(
      entryId,
      scored.map(({ section }) => ({ section: section.id, document: section.document, ...excerptOf(section.text) })),
    );
  }
  return selected;
}

/** value が text の中に 1 つの語として現れるか。どちらも小文字にしてから渡す。 */
export function containsWord(text: string, value: string): boolean {
  if (value === "") return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(value, from);
    if (at < 0) return false;
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + value.length])) return true;
    from = at + 1;
  }
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_-]/.test(ch);
}

/** 節の本文の抜粋（先頭の EXCERPT_CHARS 字まで）。IntentSynthesizer も同じ規則で抜粋を作る。 */
export function excerptOf(text: string): { text: string; truncated: boolean } {
  const chars = Array.from(text);
  return chars.length <= EXCERPT_CHARS
    ? { text, truncated: false }
    : { text: chars.slice(0, EXCERPT_CHARS).join(""), truncated: true };
}

/**
 * 意味（資料の抜粋）の本文（GlossaryBuilder の設計 5.3）。LLM に渡した抜粋（excerptOf の結果）から切り出すので、
 * 意味の抜粋が変われば LLM の入力も変わり、記録のキーも変わる。
 * - 見出しの節（識別子が "#" で終わらない節）は、先頭の見出しの行を飛ばす。見出しの無い節とスキーマは飛ばさない。
 * - 続く空行を飛ばし、次の空行の直前までの最初の段落を取る。段落が無ければ null。
 * - 段落がソースコードの囲み（言語の名前が SOURCE_CODE_LANGUAGES にある ``` か ~~~ の囲み）で始まるときは、
 *   囲みの終わりまで飛ばして次の段落を取る（Q5）。言語の名前が無い囲みと、仕様の記法の囲み（alloy・mermaid など）は飛ばさない。
 *   囲みが抜粋の末尾まで続くときは null。
 * - 先頭の MEANING_CHARS 字まで。上限で切ったとき、または段落が LLM の抜粋の末尾まで続き、その抜粋が切られていたときは truncated。
 * - 本文には何も足さない（節の本文にある文字列そのもの）。
 */
export function meaningOf(selected: SelectedSection): { text: string; truncated: boolean } | null {
  const lines = selected.text.split("\n");
  let start = selected.section.endsWith("#") ? 0 : 1;
  for (;;) {
    while (start < lines.length && (lines[start] ?? "").trim() === "") start += 1;
    const open = CODE_FENCE.exec(lines[start] ?? "");
    if (open === null || !SOURCE_CODE_LANGUAGES.has((open[2] ?? "").toLowerCase())) break;
    let close = start + 1;
    while (close < lines.length && !(lines[close] ?? "").trimStart().startsWith(open[1] ?? "")) close += 1;
    if (close >= lines.length) return null;
    start = close + 1;
  }
  let end = start;
  while (end < lines.length && (lines[end] ?? "").trim() !== "") end += 1;
  if (end === start) return null;
  const chars = Array.from(lines.slice(start, end).join("\n"));
  const cut = chars.length > MEANING_CHARS;
  return {
    text: cut ? chars.slice(0, MEANING_CHARS).join("") : chars.join(""),
    truncated: cut || (end === lines.length && selected.truncated),
  };
}

function baseNameOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}