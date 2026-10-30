// GlossaryBuilder（ユビキタス言語辞書）の公開する関数（GlossaryBuilder の設計 1.2・2）。
// 全体マップと仕様の資料から、用語と、用語と実装名の対応を作る。全体マップは読むだけで書き換えない。
// Step 1〜3 と Step 5 は決定的。Step 4（用語）だけが LLM を使う。LLM が無ければ用語はすべて NOT_GENERATED（UNREACHABLE）。

import type { JsonValue } from "../types/index.js";
import type { EventStormingMap, RepositoryArtifacts } from "../types/scenario.js";
import type { Glossary, GlossaryEntry } from "../types/glossary.js";
import type { LanguageModelPort } from "../ports/LanguageModelPort.js";
import { canonicalJson } from "../lib/canonical_json.js";
import { sha256Hex } from "../lib/sha256.js";
import { compareIds } from "./m0/boundary.js";
import { collectEntries } from "./glossary/entries.js";
import { recordGaps } from "./glossary/gaps.js";
import { cluesOf, selectSections } from "./glossary/match.js";
import { splitSections } from "./glossary/sections.js";
import { nameTerms } from "./glossary/terms.js";

export async function buildGlossary(
  map: EventStormingMap,
  repo: RepositoryArtifacts,
  deps: { llm?: LanguageModelPort },
): Promise<Glossary> {
  const sections = splitSections(repo.documents);
  const collected = collectEntries(map, repo.documents);
  const selected = selectSections(cluesOf(map), sections);
  const terms = await nameTerms(map, repo, selected, deps.llm);

  const entries: GlossaryEntry[] = collected.map((entry) => {
    if (entry.scope === "RECORDED") {
      return { id: entry.id, kind: entry.kind, scope: entry.scope, implementation: entry.implementation, sources: [] };
    }
    const term = terms.get(entry.id);
    // 提示する項目は、すべて Step 4 で用語を頼んでいる。無ければ Step 2 と Step 4 の食い違い（実装の誤り）なので止める。
    if (term === undefined) throw new Error(`GlossaryBuilder: 提示する項目 ${entry.id} に用語の結果が無い`);
    return {
      id: entry.id,
      kind: entry.kind,
      scope: entry.scope,
      term,
      implementation: entry.implementation,
      sources: (selected.get(entry.id) ?? []).map((section) => section.section),
    };
  });

  const documentsJson: JsonValue = [...repo.documents]
    .sort((a, b) => compareIds(a.path, b.path))
    .map((document) => ({ path: document.path, text: document.text }));
  return {
    entries,
    gaps: recordGaps(entries, sections, selected),
    documents: {
      read: repo.documents.map((document) => document.path).sort(compareIds),
      truncated: repo.documents.filter((document) => document.truncated).map((document) => document.path).sort(compareIds),
      omitted: [...repo.omittedDocuments].sort(compareIds),
    },
    basis: {
      mapHash: await mapHashOf(map),
      documentsHash: await sha256Hex(canonicalJson(documentsJson)),
    },
  };
}

/**
 * 全体マップの SHA-256（辞書の basis.mapHash）。SpecProjector が辞書の古さ（GLOSSARY_STALE）を確かめるときも、これを使う。
 * 全体マップは JSON にできる値だけでできている。値が undefined の任意の欄が実行時に混じっても止まらないように、
 * JSON に一度書いて読み直してから正準化する（undefined の欄は落ちる）。
 */
export async function mapHashOf(map: EventStormingMap): Promise<string> {
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(map)) as JsonValue));
}