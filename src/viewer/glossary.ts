// 用語辞典のビューモデル（SpecViewer 基本設計 3.5・6.8）。
// 純粋な関数。checkRunOutputs を通った RunOutputs を受け取る（通っていない入力では例外を投げる）。
// 表示の id（"c1"・"n1"）は implementation_map.json の行の glossaryEntryId で引く。
// 対応表は俯瞰図と同じ順で番号を振る（implementation_map.ts の先頭のコメント、render_system.ts）。
// ビューモデルには地図の識別子（内部の識別子）を入れない（設計 4 節）。

import { statusMark } from "../core/m5/labels.js";
import type { Glossary, GlossaryEntry, PresentedEntryKind } from "../types/glossary.js";
import type { ImplementationMap, ViewRole } from "../types/projection.js";
import { labelOfEntry, sourcesOf } from "./commands.js";
import type {
  GlossaryContextSectionView,
  GlossaryEntryView,
  GlossaryGapsView,
  GlossarySourceView,
  GlossaryView,
  RunOutputs,
} from "./types.js";

/** 種類の文。俯瞰図（render_system.ts の KIND_TEXT）と同じ文にする（設計 6.8）。 */
const KIND_TEXT: Readonly<Record<PresentedEntryKind, string>> = {
  BOUNDED_CONTEXT: "Bounded Context",
  COMMAND: "コマンド",
  EVENT: "イベント",
  POLICY: "ポリシー",
};
const PRESENTED_KINDS: ReadonlySet<string> = new Set(Object.keys(KIND_TEXT));

const NO_GLOSSARY = "辞書（glossary.json）が無いため、用語辞典を出せない。";
const NO_MAP_NOTE = "表示の id を引けない: 実装との対応表が無い";
const NO_MEANING = "資料に記述が無い";
const NO_CONTEXT = "所属する Bounded Context が無い";
/** 候補には印を付けないので（labels.ts の statusMark）、SpecProjector の仕様書と同じく 1 回だけ書く（render_document.ts）。 */
const STATUS_NOTE =
  "この辞書の用語と意味は、人が確かめていない候補である。人が確定したものには「（確定）」、確定のあとで元の資料やコードが変わったものには「（要再確認）」を付けた。";

/** BUSINESS の意味の抜粋で、コードのパスの代わりに置く文（Q6）。 */
const HIDDEN_PATH = "（コードのパス）";
const INLINE_CODE = /`([^`\n]+)`/g;
/** インラインコードの中身が、パスの区切りに src/ を含むか。 */
const SRC_IN_CODE = /(?:^|[\s/])src\//;
/** 囲まれていないパス。英字・数字・_・.・-・/ の続きで、区切りに src/ を含むもの。 */
const BARE_SRC_PATH = /(?<![\w./-])(?:[\w.-]+\/)*src\/[\w./-]*/g;

/**
 * 意味の抜粋から、資料が書いたコードのパス（区切りに src/ を含むもの）を HIDDEN_PATH に置き換える（Q6。BUSINESS だけ）。
 * パスを含むインラインコードは囲みごと置き換える。パスを含まないインラインコード（関数名など）は残す。
 */
export function hideSourcePaths(text: string): string {
  return text
    .replace(INLINE_CODE, (whole: string, code: string) => (SRC_IN_CODE.test(code) ? HIDDEN_PATH : whole))
    .replace(BARE_SRC_PATH, HIDDEN_PATH);
}

type Presented = GlossaryEntry & { kind: PresentedEntryKind };

function isPresented(entry: GlossaryEntry): entry is Presented {
  return entry.scope === "PRESENTED" && PRESENTED_KINDS.has(entry.kind);
}

/** 辞書の項目の id → 表示の id（"c1"・"n1"）。対応表が無ければ null。全体地図（map.ts）も同じ表で引く。 */
export function displayIdsOf(map: ImplementationMap | null): Map<string, string> | null {
  if (map === null) return null;
  const result = new Map<string, string>();
  for (const row of map.entries) {
    if (PRESENTED_KINDS.has(row.kind) && row.glossaryEntryId !== null) result.set(row.glossaryEntryId, row.displayId);
  }
  return result;
}

/** 表示の id の並びの順（c が先、それぞれ番号の順）。引けなければ null。 */
function rankOf(displayId: string | null): number | null {
  const match = displayId === null ? null : /^([cn])(\d+)$/.exec(displayId);
  if (match === null) return null;
  return (match[1] === "c" ? 0 : 1_000_000) + Number(match[2] ?? "");
}

/**
 * 節の識別子「<資料のパス>#<見出しの並び>」（GlossaryBuilder 設計 2 節）を資料と見出しに分ける。
 * パスに "#" があっても誤らないよう、読んだ資料のうち最も長く一致するパスで分ける。一致しなければ最初の "#" で分ける。
 */
export function sourceOf(sectionId: string, documents: readonly string[]): GlossarySourceView {
  const document = [...documents].sort((a, b) => b.length - a.length).find((path) => sectionId.startsWith(`${path}#`));
  if (document !== undefined) return { document, heading: sectionId.slice(document.length + 1) };
  const at = sectionId.indexOf("#");
  return at < 0 ? { document: sectionId, heading: "" } : { document: sectionId.slice(0, at), heading: sectionId.slice(at + 1) };
}

export function buildGlossaryView(outputs: RunOutputs, viewRole: ViewRole): GlossaryView {
  const sources = sourcesOf(outputs);
  const glossary: Glossary | null = sources.glossary;
  if (glossary === null) {
    return { unavailable: NO_GLOSSARY, statusNote: null, displayIdNote: null, showContextSections: false, sections: [], gaps: null };
  }

  const displayIds = displayIdsOf(sources.implementationMap);
  const displayIdOf = (id: string): string | null => displayIds?.get(id) ?? null;
  const documents = [...glossary.documents.read, ...glossary.documents.truncated];
  const presented = glossary.entries.filter(isPresented);
  const byId = new Map(glossary.entries.map((entry) => [entry.id, entry] as const));

  /** 対応表で全項目の番号が引けるときだけ俯瞰図の順に並べる。引けなければ辞書の順（id の辞書順）のまま。 */
  const ordered = <T extends Presented>(list: readonly T[]): T[] => {
    const ranks = list.map((entry) => rankOf(displayIdOf(entry.id)));
    if (ranks.some((rank) => rank === null)) return [...list];
    return list
      .map((entry, index) => [entry, ranks[index] as number] as const)
      .sort((a, b) => a[1] - b[1])
      .map(([entry]) => entry);
  };

  const termOf = (id: string): string => labelOfEntry(glossary, id, byId.get(id)?.kind ?? "BOUNDED_CONTEXT").text;

  /** Bounded Context の名前。用語が無ければ俯瞰図と同じく「Bounded Context c1（名前は未生成）」。 */
  const contextName = (id: string): string => {
    const label = labelOfEntry(glossary, id, "BOUNDED_CONTEXT");
    if (label.ok) return label.text;
    const displayId = displayIdOf(id);
    return displayId === null ? `Bounded Context${label.text}` : `Bounded Context ${displayId}${label.text}`;
  };

  const entryView = (entry: Presented, crossing: string | null): GlossaryEntryView => ({
    displayId: displayIdOf(entry.id),
    kind: entry.kind,
    kindText: KIND_TEXT[entry.kind],
    term: labelOfEntry(glossary, entry.id, entry.kind).text,
    termStatus: entry.termStatus ?? "NOT_GENERATED",
    meaning:
      entry.excerpt === null
        ? NO_MEANING
        : `${viewRole === "BUSINESS" ? hideSourcePaths(entry.excerpt.text) : entry.excerpt.text}${statusMark(entry.excerpt.status)}`,
    meaningTruncated: entry.excerpt?.truncated ?? false,
    sources: entry.sources.map((id) => sourceOf(id, documents)),
    crossing,
    implementation:
      viewRole === "IMPLEMENTATION"
        ? { names: [...entry.implementation.names], locations: entry.implementation.locations.map((location) => ({ ...location })) }
        : null,
  });

  // ---- Bounded Context ごとの区切り（またぐポリシーは両方に出す。設計 3.5） ----
  const contexts = ordered(presented.filter((entry) => entry.kind === "BOUNDED_CONTEXT"));
  const known = new Set(contexts.map((context) => context.id));
  const sections: GlossaryContextSectionView[] = contexts.map((context) => {
    const members = ordered(
      presented.filter((entry) => entry !== context && (entry.contextId === context.id || entry.crossesTo === context.id)),
    );
    const crossingIn = (entry: Presented): string | null => {
      if (entry.crossesTo === null) return null;
      if (entry.contextId === context.id) return `${contextName(entry.crossesTo)}へまたぐ`;
      return `${entry.contextId === null ? NO_CONTEXT : contextName(entry.contextId)}からまたいでくる`;
    };
    return {
      displayId: displayIdOf(context.id),
      title: contextName(context.id),
      entries: [entryView(context, null), ...members.map((entry) => entryView(entry, crossingIn(entry)))],
    };
  });
  const unassigned = ordered(
    presented.filter((entry) => entry.kind !== "BOUNDED_CONTEXT" && (entry.contextId === null || !known.has(entry.contextId))),
  );
  if (unassigned.length > 0) {
    sections.push({
      displayId: null,
      title: NO_CONTEXT,
      entries: unassigned.map((entry) => entryView(entry, entry.crossesTo === null ? null : `${contextName(entry.crossesTo)}へまたぐ`)),
    });
  }

  // ---- 資料とコードのずれ（設計 3.5） ----
  const ref = (id: string) => ({ displayId: displayIdOf(id), term: termOf(id) });
  const gaps: GlossaryGapsView = {
    undocumented: glossary.gaps.undocumentedEntries.map(ref),
    sharedTerms: glossary.gaps.sharedTerms.map((item) => ({
      term: item.term,
      context: contextName(item.contextId),
      entries: item.entryIds.map(ref),
    })),
    contextHomonyms: glossary.gaps.contextHomonyms.map((item) => ({
      term: item.term,
      entries: item.entries.map((entry) => ({ ...ref(entry.entryId), context: contextName(entry.contextId) })),
    })),
    multiSource: glossary.gaps.multiSourceEntries.map((item) => ({ ...ref(item.entryId), documents: [...item.documents] })),
    // 資料のインラインコードの名前は実装の側の情報なので、IMPLEMENTATION だけに出す（Q8）。
    unmatchedDocumentNames:
      viewRole === "IMPLEMENTATION"
        ? {
            count: glossary.gaps.unmatchedDocumentNames.length,
            items: glossary.gaps.unmatchedDocumentNames.map((item) => ({
              name: item.name,
              sources: item.sections.map((id) => sourceOf(id, documents)),
            })),
          }
        : null,
  };

  return {
    unavailable: null,
    statusNote: STATUS_NOTE,
    displayIdNote: displayIds === null ? NO_MAP_NOTE : null,
    showContextSections: contexts.length > 1 || unassigned.length > 0,
    sections,
    gaps,
  };
}