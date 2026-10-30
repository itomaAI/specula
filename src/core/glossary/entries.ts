// Step 2: EntryCollector（GlossaryBuilder の設計 3.2）。辞書の項目を集める。LLM を使わない。
//
// - 提示する項目（PRESENTED）: Bounded Context・コマンド・イベント・ポリシー。識別子は地図の識別子。
// - 記録だけの項目（RECORDED）: アクター・リードモデル（地図の識別子）、DB の書き込み先とイベントの発行の名前
//   （シグナルの label。同じ名前は 1 項目にまとめ、所在を一覧で持つ）、スキーマのエンティティと項目。
// - 状態の変数は後段が見つけるので集めない。
//
// スキーマの読み方（初回。構文の解析器は持たない）:
// - SQL: CREATE TABLE <名前> ( から、括弧が閉じるまでの各行の先頭の語。制約の行（PRIMARY・FOREIGN・CONSTRAINT・
//   UNIQUE・CHECK・KEY・INDEX で始まる行）は項目にしない。
// - Prisma: model <名前> { から } までの各行の先頭の語（@@ で始まる行は読まない）。
// - GraphQL: type・input・interface の <名前> { から } までの各行の、: の前の語（引数の括弧は飛ばす）。
// - コメントの行（--・//・#）と、どれにも当たらない行は読まない。

import type { EventStormingMap, RepositoryDocument } from "../../types/scenario.js";
import type { EntryKind, GlossaryEntry, GlossaryLocation } from "../../types/glossary.js";
import { compareIds } from "../m0/boundary.js";

/** 集めた項目。sources と term は後のステップで付ける。 */
export type CollectedEntry = Omit<GlossaryEntry, "term" | "sources">;

export function collectEntries(map: EventStormingMap, documents: readonly RepositoryDocument[]): CollectedEntry[] {
  const entries = new Map<string, { kind: EntryKind; scope: CollectedEntry["scope"]; names: Set<string>; locations: GlossaryLocation[] }>();
  const add = (id: string, kind: EntryKind, names: Array<string | null>, locations: GlossaryLocation[]): void => {
    const scope: CollectedEntry["scope"] = isPresented(kind) ? "PRESENTED" : "RECORDED";
    const entry = entries.get(id) ?? { kind, scope, names: new Set<string>(), locations: [] };
    for (const name of names) if (name !== null && name !== "") entry.names.add(name);
    entry.locations.push(...locations);
    entries.set(id, entry);
  };

  // ---- 提示する項目 ----
  for (const context of map.boundedContexts) {
    add(context.id, "BOUNDED_CONTEXT", [context.name], context.rootPaths.map((file) => ({ file })));
  }
  for (const command of map.commands) {
    add(command.id, "COMMAND", [command.handler.symbol], [{ ...command.handler }]);
  }
  for (const event of map.events) {
    add(event.id, "EVENT", [event.handler.symbol, event.signal.label], [
      { ...event.handler },
      { file: event.handler.file, line: event.signal.line },
    ]);
  }
  const eventById = new Map(map.events.map((event) => [event.id, event] as const));
  for (const policy of map.policies) {
    add(policy.id, "POLICY", [policy.listener.symbol, eventById.get(policy.triggerEventId)?.signal.label ?? null], [
      { ...policy.listener },
    ]);
  }

  // ---- 記録だけの項目 ----
  for (const actor of map.actors) add(actor.id, "ACTOR", [actor.name], []);
  for (const readModel of map.readModels) add(readModel.id, "READ_MODEL", [readModel.route], [{ file: readModel.componentFile }]);
  for (const event of map.events) {
    const label = event.signal.label;
    if (label === null) continue;
    const location = { file: event.handler.file, symbol: event.handler.symbol, line: event.signal.line };
    if (event.signal.kind === "DB_MUTATION") add(`DB_TARGET:${label}`, "DB_TARGET", [label], [location]);
    if (event.signal.kind === "EVENT_EMIT") add(`EMITTED_EVENT_NAME:${label}`, "EMITTED_EVENT_NAME", [label], [location]);
  }
  for (const document of documents) {
    if (document.kind !== "SCHEMA") continue;
    for (const entity of readSchema(document.path, document.text)) {
      add(`SCHEMA_ENTITY:${entity.name}`, "SCHEMA_ENTITY", [entity.name], [{ file: document.path, line: entity.line }]);
      for (const field of entity.fields) {
        const name = `${entity.name}.${field.name}`;
        add(`SCHEMA_FIELD:${name}`, "SCHEMA_FIELD", [name], [{ file: document.path, line: field.line }]);
      }
    }
  }

  return [...entries.entries()]
    .map(([id, entry]) => ({
      id,
      kind: entry.kind,
      scope: entry.scope,
      implementation: { names: [...entry.names].sort(compareIds), locations: sortLocations(entry.locations) },
    }))
    .sort((a, b) => compareIds(a.id, b.id));
}

export function isPresented(kind: EntryKind): boolean {
  return kind === "BOUNDED_CONTEXT" || kind === "COMMAND" || kind === "EVENT" || kind === "POLICY";
}

/** ファイル・行・関数名の順に並べ、同じものを 1 つにする。行の無い所在は、同じファイルの中で先に置く。 */
function sortLocations(locations: readonly GlossaryLocation[]): GlossaryLocation[] {
  const keyOf = (l: GlossaryLocation): string => `${l.file}\u0000${l.line ?? ""}\u0000${l.symbol ?? ""}`;
  const unique = new Map(locations.map((l) => [keyOf(l), l] as const));
  return [...unique.values()].sort(
    (a, b) => compareIds(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0) || compareIds(a.symbol ?? "", b.symbol ?? ""),
  );
}

// ---------------------------------------------------------------------------
// スキーマ

export interface SchemaEntity {
  name: string;
  line: number;
  fields: Array<{ name: string; line: number }>;
}

const SQL_CONSTRAINTS = new Set(["PRIMARY", "FOREIGN", "CONSTRAINT", "UNIQUE", "CHECK", "KEY", "INDEX"]);

export function readSchema(path: string, text: string): SchemaEntity[] {
  const lower = path.toLowerCase();
  const lines = text.split("\n");
  if (lower.endsWith(".sql")) return readSql(lines);
  if (lower.endsWith(".prisma")) return readBlocks(lines, /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/, prismaField);
  if (lower.endsWith(".graphql") || lower.endsWith(".gql")) {
    return readBlocks(lines, /^\s*(?:type|input|interface)\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{/, graphqlField);
  }
  return [];
}

function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("--") || trimmed.startsWith("//") || trimmed.startsWith("#");
}

function unquote(word: string): string {
  return word.replace(/^[`"[]+|[`"\]]+$/g, "");
}

function readSql(lines: readonly string[]): SchemaEntity[] {
  const entities: SchemaEntity[] = [];
  const create = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([`"[\]A-Za-z0-9_.]+)\s*\(/i;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isComment(line)) continue;
    const match = create.exec(line);
    if (match === null) continue;
    const qualified = unquote(match[1] ?? "").split(".").map(unquote);
    const name = qualified[qualified.length - 1] ?? "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const entity: SchemaEntity = { name, line: i + 1, fields: [] };
    // 開きの括弧の後ろから数え始め、括弧が閉じた行で終わる。
    let depth = depthChange(line.slice(line.indexOf("(", match.index)));
    while (depth > 0 && i + 1 < lines.length) {
      i += 1;
      const body = lines[i] ?? "";
      depth += depthChange(body);
      if (isComment(body)) continue;
      const word = unquote((/^\s*([`"[]?[A-Za-z_][A-Za-z0-9_]*[`"\]]?)/.exec(body)?.[1]) ?? "");
      if (word === "" || SQL_CONSTRAINTS.has(word.toUpperCase())) continue;
      entity.fields.push({ name: word, line: i + 1 });
    }
    // 括弧が閉じない定義は読めなかったものとして記録しない。
    if (depth <= 0) entities.push(entity);
  }
  return entities;
}

function depthChange(text: string): number {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
  }
  return depth;
}

function prismaField(line: string): string | null {
  if (line.trimStart().startsWith("@@")) return null;
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)\s/.exec(line)?.[1] ?? null;
}

function graphqlField(line: string): string | null {
  return /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:/.exec(line)?.[1] ?? null;
}

function readBlocks(
  lines: readonly string[],
  open: RegExp,
  fieldOf: (line: string) => string | null,
): SchemaEntity[] {
  const entities: SchemaEntity[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isComment(line)) continue;
    const match = open.exec(line);
    if (match === null) continue;
    const entity: SchemaEntity = { name: match[1] ?? "", line: i + 1, fields: [] };
    let closed = line.includes("}");
    while (!closed && i + 1 < lines.length) {
      i += 1;
      const body = lines[i] ?? "";
      if (body.includes("}")) {
        closed = true;
        continue;
      }
      if (isComment(body)) continue;
      const field = fieldOf(body);
      if (field !== null) entity.fields.push({ name: field, line: i + 1 });
    }
    // 閉じが見つからない定義は読めなかったものとして記録しない。
    if (closed) entities.push(entity);
  }
  return entities;
}