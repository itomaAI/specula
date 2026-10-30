// GlossaryBuilder（ユビキタス言語辞書）の公開する関数（GlossaryBuilder の設計 1.2・2）。
// 全体マップと仕様の資料から、用語と、用語と実装名の対応を作る。全体マップは読むだけで書き換えない。
// Step 1〜3 と Step 5 は決定的。Step 4（用語）だけが LLM を使う。LLM が無ければ用語はすべて NOT_GENERATED（UNREACHABLE）。

import type { JsonValue } from "../types/index.js";
import type { EventStormingMap, RepositoryArtifacts, RepositoryDocument } from "../types/scenario.js";
import type { Glossary, GlossaryEntry } from "../types/glossary.js";
import type { LanguageModelPort } from "../ports/LanguageModelPort.js";
import { canonicalJson } from "../lib/canonical_json.js";
import { sha256Hex } from "../lib/sha256.js";
import { compareIds } from "./m0/boundary.js";
import { collectEntries, contextsOf } from "./glossary/entries.js";
import { recordGaps } from "./glossary/gaps.js";
import { cluesOf, meaningOf, selectSections } from "./glossary/match.js";
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
  const contexts = contextsOf(map);

  const entries: GlossaryEntry[] = collected.map((entry): GlossaryEntry => {
    if (entry.scope === "RECORDED") {
      return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        implementation: entry.implementation,
        sources: [],
        contextId: null,
        crossesTo: null,
        termStatus: null,
        excerpt: null,
      };
    }
    const term = terms.get(entry.id);
    // 提示する項目は、すべて Step 4 で用語を頼んでいる。無ければ Step 2 と Step 4 の食い違い（実装の誤り）なので止める。
    if (term === undefined) throw new Error(`GlossaryBuilder: 提示する項目 ${entry.id} に用語の結果が無い`);
    const chosen = selected.get(entry.id) ?? [];
    const first = chosen[0];
    const meaning = first === undefined ? null : meaningOf(first);
    const context = contexts.get(entry.id) ?? { contextId: null, crossesTo: null };
    return {
      id: entry.id,
      kind: entry.kind,
      scope: entry.scope,
      term,
      implementation: entry.implementation,
      sources: chosen.map((section) => section.section),
      contextId: context.contextId,
      crossesTo: context.crossesTo,
      // 確定の操作は無いので、書くのは NOT_GENERATED と CANDIDATE だけ（設計 5.1）。
      termStatus: term.status === "GENERATED" ? "CANDIDATE" : "NOT_GENERATED",
      excerpt:
        first === undefined || meaning === null
          ? null
          : { text: meaning.text, source: first.section, truncated: meaning.truncated, status: "CANDIDATE" },
    };
  });

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
      documentsHash: await documentsHashOf(repo.documents),
    },
  };
}

/**
 * 資料の SHA-256（辞書の basis.documentsHash）。資料をパスの辞書順に並べ、パスと本文だけを正準化する。
 * IntentSynthesizer が、辞書の選んだ節を同じ資料から切り出せるかを確かめるときも、これを使う。
 */
export async function documentsHashOf(documents: readonly RepositoryDocument[]): Promise<string> {
  const documentsJson: JsonValue = [...documents]
    .sort((a, b) => compareIds(a.path, b.path))
    .map((document) => ({ path: document.path, text: document.text }));
  return sha256Hex(canonicalJson(documentsJson));
}

/**
 * 全体マップの SHA-256（辞書の basis.mapHash）。SpecProjector が辞書の古さ（GLOSSARY_STALE）を確かめるときも、これを使う。
 * 全体マップは JSON にできる値だけでできている。値が undefined の任意の欄が実行時に混じっても止まらないように、
 * JSON に一度書いて読み直してから正準化する（undefined の欄は落ちる）。
 */
export async function mapHashOf(map: EventStormingMap): Promise<string> {
  return sha256Hex(canonicalJson(JSON.parse(JSON.stringify(map)) as JsonValue));
}