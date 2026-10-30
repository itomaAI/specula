// Step 5: GapRecorder（GlossaryBuilder の設計 3.5）。ずれと同義・多義の候補を記録する。記録するだけで、項目や用語を変えない。

import type { GlossaryEntry, GlossaryGaps } from "../../types/glossary.js";
import { compareIds } from "../m0/boundary.js";
import type { SelectedSection } from "./match.js";
import type { DocumentSection } from "./sections.js";

const FENCE = /^ {0,3}(```|~~~)/;
const INLINE_NAME = /`([A-Za-z_][A-Za-z0-9_.]*)(?:\(\))?`/g;

export function recordGaps(
  entries: readonly GlossaryEntry[],
  sections: readonly DocumentSection[],
  selected: ReadonlyMap<string, readonly SelectedSection[]>,
): GlossaryGaps {
  const presented = entries.filter((entry) => entry.scope === "PRESENTED");

  const undocumentedEntries = presented
    .filter((entry) => (selected.get(entry.id) ?? []).length === 0)
    .map((entry) => entry.id)
    .sort(compareIds);

  const knownNames = new Set(entries.flatMap((entry) => entry.implementation.names));
  const unmatched = new Map<string, Set<string>>();
  for (const section of sections) {
    if (section.kind === "SCHEMA") continue;
    for (const name of inlineNamesOf(section.text)) {
      if (knownNames.has(name)) continue;
      const found = unmatched.get(name) ?? new Set<string>();
      found.add(section.id);
      unmatched.set(name, found);
    }
  }
  const unmatchedDocumentNames = [...unmatched.entries()]
    .map(([name, found]) => ({ name, sections: [...found].sort(compareIds) }))
    .sort((a, b) => compareIds(a.name, b.name));

  // 同義の候補は Bounded Context ごとに数え、違う Bounded Context の同じ用語は別の区分にする（設計 5.2）。
  // 所属が決まらない項目（反応するイベントが全体マップに無いポリシー）は、どちらにも数えない。
  const byTerm = new Map<string, Map<string, string[]>>();
  for (const entry of presented) {
    if (entry.term?.status !== "GENERATED" || entry.contextId === null) continue;
    const contexts = byTerm.get(entry.term.term) ?? new Map<string, string[]>();
    contexts.set(entry.contextId, [...(contexts.get(entry.contextId) ?? []), entry.id]);
    byTerm.set(entry.term.term, contexts);
  }
  const sharedTerms = [...byTerm.entries()]
    .flatMap(([term, contexts]) =>
      [...contexts.entries()]
        .filter(([, ids]) => ids.length >= 2)
        .map(([contextId, ids]) => ({ term, contextId, entryIds: [...ids].sort(compareIds) })),
    )
    .sort((a, b) => compareIds(a.term, b.term) || compareIds(a.contextId, b.contextId));
  const contextHomonyms = [...byTerm.entries()]
    .filter(([, contexts]) => contexts.size >= 2)
    .map(([term, contexts]) => ({
      term,
      entries: [...contexts.entries()]
        .map(([contextId, ids]) => ({ entryId: [...ids].sort(compareIds)[0] ?? "", contextId }))
        .sort((a, b) => compareIds(a.contextId, b.contextId)),
    }))
    .sort((a, b) => compareIds(a.term, b.term));

  const multiSourceEntries = presented
    .map((entry) => ({
      entryId: entry.id,
      documents: [...new Set((selected.get(entry.id) ?? []).map((s) => s.document))].sort(compareIds),
    }))
    .filter((item) => item.documents.length >= 2)
    .sort((a, b) => compareIds(a.entryId, b.entryId));

  return { undocumentedEntries, unmatchedDocumentNames, sharedTerms, contextHomonyms, multiSourceEntries };
}

/** コードの囲みの外にあるインラインコードのうち、識別子の形をした名前。 */
export function inlineNamesOf(text: string): string[] {
  const names: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1] ?? "";
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.matchAll(INLINE_NAME)) names.push(match[1] ?? "");
  }
  return names.filter((name) => name !== "");
}