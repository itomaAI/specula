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

function baseNameOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}