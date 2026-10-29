// 経路のたどり方とスライスの元になる出口の経路（M1 の設計 2.1・3、M1 の計画「経路のたどり方」「追跡した関数の中身の扱い」）。
//
// 続く経路を常に 1 本に保ち、スライスの数を出口の数にそろえる。
// - 片側がいつも終わる（return・throw・break・continue）枝は、続く経路に「その側に入らなかった」条件を足す。
// - 両側とも続くときは、条件を足さずに中のユニットだけを続く経路に入れる（書き込みには details.guard で条件を付ける）。
// - 入れ子の関数（コールバックなど）の中には入らない。その関数を受け取った呼び出しが EXTERNAL_CALL として残る。
// - 式の中の短絡評価（a && f()）と三項演算子は分けない（初回の範囲）。

import type { OutletKind } from "../../types/context.js";
import { type AstNode, childrenOf, isAstNode } from "../m0/ast.js";
import { classifyCall } from "../m0/signals.js";
import { type FunctionRef, isCallableNode, refKey, resolveCall } from "./locate.js";
import { type LoadedFile, type SourceLoader, endOf, sourceText, startOf } from "./source_loader.js";
import { type UnitCollector, callDetails } from "./units.js";

export interface PathCondition {
  unitId: string;
  expression: string;
  holds: boolean;
}

export interface ExitPath {
  conditions: PathCondition[];
  unitIds: string[];
  writes: string[];
  outlet: { unitId: string; kind: OutletKind };
  /** 呼ばれた関数から伝わった出口のとき、呼び出しのユニットの識別子（外側から順）。 */
  chain: string[];
}

interface Path {
  conditions: PathCondition[];
  unitIds: string[];
  writes: string[];
}

/** FALL: 次の文へ続く。EXIT: 関数の出口に至った。JUMP: break・continue・catch への throw で、この並びを抜けた。 */
interface Flow {
  term: "FALL" | "EXIT" | "JUMP";
  path: Path;
}

interface Summary {
  /** catch されない throw の経路（呼び出した側の出口になる）。 */
  throwExits: ExitPath[];
  /** throw 以外の経路で通るユニット（呼び出した側の経路に入れる）。 */
  bodyUnits: string[];
  bodyWrites: string[];
}

interface Context {
  file: LoadedFile;
  fn: FunctionRef;
  /** いま中にいる枝の条件（書き込みの guard と guardTerms に使う）。unitId は BRANCH_CONDITION のユニット。 */
  guard: Array<{ unitId: string; expression: string; holds: boolean }>;
  exits: ExitPath[];
  /** catch のある try の中なら、throw した経路をここへ入れる。 */
  catchSink: Path[] | null;
  /** ループと switch の中なら、break・continue した経路をここへ入れる。 */
  jumpSink: Path[] | null;
  firebaseNames: Set<string>;
}

/** 呼び出した側の経路に入れるユニットの種類（条件と出口は入れない）。 */
const INLINED_KINDS = new Set(["CALL", "STATE_WRITE", "DATA_MUTATION", "EXTERNAL_CALL", "ASYNC_CUT", "RECURSION"]);
const FIRESTORE_MODULAR = new Set(["addDoc", "setDoc", "updateDoc", "deleteDoc"]);

export class PathWalker {
  private readonly summaries = new Map<string, Promise<Summary>>();
  private readonly stack = new Set<string>();

  constructor(
    private readonly loader: SourceLoader,
    private readonly units: UnitCollector,
  ) {}

  /** 起点の関数の出口の経路。 */
  async exitsOf(inlet: FunctionRef): Promise<ExitPath[]> {
    const key = refKey(inlet);
    this.stack.add(key);
    try {
      return await this.walkFunction(inlet);
    } finally {
      this.stack.delete(key);
    }
  }

  private summaryOf(ref: FunctionRef): Promise<Summary> {
    const key = refKey(ref);
    let pending = this.summaries.get(key);
    if (pending === undefined) {
      pending = this.computeSummary(ref, key);
      this.summaries.set(key, pending);
    }
    return pending;
  }

  private async computeSummary(ref: FunctionRef, key: string): Promise<Summary> {
    this.stack.add(key);
    try {
      const exits = await this.walkFunction(ref);
      const summary: Summary = { throwExits: [], bodyUnits: [], bodyWrites: [] };
      for (const exit of exits) {
        if (exit.outlet.kind === "THROW") {
          summary.throwExits.push(exit);
          continue;
        }
        appendUnique(
          summary.bodyUnits,
          exit.unitIds.filter((id) => INLINED_KINDS.has(this.units.get(id)?.kind ?? "")),
        );
        appendUnique(summary.bodyWrites, exit.writes);
      }
      return summary;
    } finally {
      this.stack.delete(key);
    }
  }

  private async walkFunction(ref: FunctionRef): Promise<ExitPath[]> {
    const ctx: Context = {
      file: ref.file,
      fn: ref,
      guard: [],
      exits: [],
      catchSink: null,
      jumpSink: null,
      firebaseNames: new Set(
        ref.file.imports
          .filter((entry) => entry.from.startsWith("firebase") && FIRESTORE_MODULAR.has(entry.imported))
          .map((entry) => entry.local),
      ),
    };
    const body = ref.node["body"];
    if (isAstNode(body) && body.type === "BlockStatement") {
      const flow = await this.block(statementsOf(body), emptyPath(), ctx);
      if (flow.term !== "EXIT") {
        this.exit(flow.path, ctx, endOf(body), "RETURN", { implicit: true, expression: null });
      }
    } else if (isAstNode(body)) {
      // 式を本体に持つアロー関数: その式を返す
      const path = emptyPath();
      await this.expression(body, path, ctx);
      this.exit(path, ctx, startOf(body), "RETURN", { implicit: false, expression: sourceText(ctx.file, body) });
    }
    return ctx.exits;
  }

  private exit(
    path: Path,
    ctx: Context,
    position: { line: number; column: number },
    kind: "RETURN" | "THROW",
    details: Record<string, string | boolean | null>,
  ): void {
    const id = this.units.add(ctx.file.path, position, kind, kind === "RETURN" ? "return" : "throw", ctx.fn.symbol, details);
    const done = clonePath(path);
    appendUnique(done.unitIds, [id]);
    ctx.exits.push({ ...done, outlet: { unitId: id, kind }, chain: [] });
  }

  private async block(statements: readonly AstNode[], start: Path, ctx: Context): Promise<Flow> {
    let path = start;
    for (const statement of statements) {
      const flow = await this.statement(statement, path, ctx);
      if (flow.term !== "FALL") return flow;
      path = flow.path;
    }
    return { term: "FALL", path };
  }

  private async statement(node: AstNode, path: Path, ctx: Context): Promise<Flow> {
    switch (node.type) {
      case "BlockStatement":
        return this.block(statementsOf(node), path, ctx);
      case "ReturnStatement": {
        await this.expression(node["argument"], path, ctx);
        const argument = node["argument"];
        this.exit(path, ctx, startOf(node), "RETURN", {
          implicit: false,
          expression: isAstNode(argument) ? sourceText(ctx.file, argument) : null,
        });
        return { term: "EXIT", path };
      }
      case "ThrowStatement": {
        await this.expression(node["argument"], path, ctx);
        const expression = sourceText(ctx.file, node["argument"]);
        if (ctx.catchSink !== null) {
          const id = this.units.add(ctx.file.path, startOf(node), "THROW", "throw", ctx.fn.symbol, { caught: true, expression });
          const thrown = clonePath(path);
          appendUnique(thrown.unitIds, [id]);
          ctx.catchSink.push(thrown);
          return { term: "JUMP", path };
        }
        this.exit(path, ctx, startOf(node), "THROW", { caught: false, expression });
        return { term: "EXIT", path };
      }
      case "BreakStatement":
      case "ContinueStatement":
        if (ctx.jumpSink !== null) ctx.jumpSink.push(clonePath(path));
        return { term: "JUMP", path };
      case "IfStatement":
        return this.ifStatement(node, path, ctx);
      case "WhileStatement":
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement":
      case "DoWhileStatement":
        return this.loop(node, path, ctx);
      case "SwitchStatement":
        return this.switchStatement(node, path, ctx);
      case "TryStatement":
        return this.tryStatement(node, path, ctx);
      case "LabeledStatement":
        return isAstNode(node["body"]) ? this.statement(node["body"], path, ctx) : { term: "FALL", path };
      case "FunctionDeclaration":
      case "ClassDeclaration":
      case "EmptyStatement":
      case "DebuggerStatement":
        return { term: "FALL", path };
      default:
        if (node.type.startsWith("TS") && node.type.endsWith("Declaration")) return { term: "FALL", path };
        await this.expression(node, path, ctx);
        return { term: "FALL", path };
    }
  }

  private async ifStatement(node: AstNode, path: Path, ctx: Context): Promise<Flow> {
    const test = node["test"];
    await this.expression(test, path, ctx);
    if (!isAstNode(test)) return { term: "FALL", path };
    const condition = this.condition(ctx, startOf(test), sourceText(ctx.file, test), {});
    const consequent = node["consequent"];
    const alternate = node["alternate"];
    const flows: Flow[] = [];
    flows.push(isAstNode(consequent) ? await this.branch(condition, true, [consequent], path, ctx) : fallWith(path, condition, true));
    flows.push(isAstNode(alternate) ? await this.branch(condition, false, [alternate], path, ctx) : fallWith(path, condition, false));
    return this.merge(path, flows);
  }

  private async loop(node: AstNode, path: Path, ctx: Context): Promise<Flow> {
    const sink: Path[] = [];
    const savedSink = ctx.jumpSink;
    let condition: PathCondition | null = null;
    if (node.type === "ForStatement") {
      const init = node["init"];
      if (isAstNode(init)) await this.statement(init, path, ctx);
    }
    if (node.type === "WhileStatement" || node.type === "ForStatement") {
      const test = node["test"];
      if (isAstNode(test)) {
        await this.expression(test, path, ctx);
        condition = this.condition(ctx, startOf(test), sourceText(ctx.file, test), { loop: node.type === "WhileStatement" ? "WHILE" : "FOR" });
      }
    } else if (node.type === "ForOfStatement" || node.type === "ForInStatement") {
      const right = node["right"];
      await this.expression(right, path, ctx);
      condition = this.condition(ctx, startOf(node), sourceText(ctx.file, right), { loop: node.type === "ForOfStatement" ? "FOR_OF" : "FOR_IN" });
    }
    const body = node["body"];
    ctx.jumpSink = sink;
    let bodyFlow: Flow;
    try {
      if (condition !== null) {
        bodyFlow = isAstNode(body) ? await this.branch(condition, true, [body], path, ctx) : fallWith(path, condition, true);
      } else {
        bodyFlow = isAstNode(body) ? await this.statement(body, clonePath(path), ctx) : { term: "FALL", path: clonePath(path) };
      }
      if (bodyFlow.term === "FALL" && node.type === "ForStatement") await this.expression(node["update"], bodyFlow.path, ctx);
      if (bodyFlow.term === "FALL" && node.type === "DoWhileStatement") await this.expression(node["test"], bodyFlow.path, ctx);
    } finally {
      ctx.jumpSink = savedSink;
    }
    if (bodyFlow.term === "EXIT" && sink.length === 0) {
      // 中身がいつも出口に至る: 続く経路は中身に入らなかった側（do…while は必ず入るので、そのまま出口）
      if (condition === null) return { term: "EXIT", path };
      return fallWith(path, condition, false);
    }
    const merged = clonePath(path);
    const reached = bodyFlow.term === "EXIT" ? sink : [bodyFlow.path, ...sink];
    for (const other of reached) this.absorb(merged, path, other);
    return { term: "FALL", path: merged };
  }

  private async switchStatement(node: AstNode, path: Path, ctx: Context): Promise<Flow> {
    const discriminant = node["discriminant"];
    await this.expression(discriminant, path, ctx);
    const subject = sourceText(ctx.file, discriminant);
    const cases = Array.isArray(node["cases"]) ? node["cases"].filter(isAstNode) : [];
    const tests = cases.map((item) => (isAstNode(item["test"]) ? sourceText(ctx.file, item["test"]) : null));
    const flows: Flow[] = [];
    let hasDefault = false;
    for (let index = 0; index < cases.length; index++) {
      const item = cases[index] as AstNode;
      const testText = tests[index] ?? null;
      let expression: string;
      if (testText !== null) {
        expression = `${subject} === ${testText}`;
      } else {
        hasDefault = true;
        const others = tests.filter((text): text is string => text !== null);
        expression = others.length === 0 ? "true" : others.map((text) => `${subject} !== ${text}`).join(" && ");
      }
      const condition = this.condition(ctx, startOf(item), expression, { switchCase: testText === null ? "DEFAULT" : "CASE" });
      const consequent = Array.isArray(item["consequent"]) ? item["consequent"].filter(isAstNode) : [];
      const sink: Path[] = [];
      const savedSink = ctx.jumpSink;
      ctx.jumpSink = sink;
      let flow: Flow;
      try {
        flow = await this.branch(condition, true, consequent, path, ctx);
      } finally {
        ctx.jumpSink = savedSink;
      }
      // break でこの case を抜けた経路は、switch の後へ続く
      for (const broken of sink) flows.push({ term: "FALL", path: broken });
      if (flow.term !== "JUMP" || sink.length === 0) flows.push(flow);
    }
    if (!hasDefault) flows.push({ term: "FALL", path: clonePath(path) });
    return this.merge(path, flows);
  }

  private async tryStatement(node: AstNode, path: Path, ctx: Context): Promise<Flow> {
    const handler = node["handler"];
    const sink: Path[] = [];
    const savedCatch = ctx.catchSink;
    if (isAstNode(handler)) ctx.catchSink = sink;
    let tryFlow: Flow;
    try {
      tryFlow = await this.block(isAstNode(node["block"]) ? statementsOf(node["block"]) : [], clonePath(path), ctx);
    } finally {
      ctx.catchSink = savedCatch;
    }
    let result: Flow = tryFlow;
    if (isAstNode(handler)) {
      const condition = this.condition(ctx, startOf(handler), "catch", { branch: "CATCH" });
      // catch に入る経路: try の中で throw の前に通ったユニットを含める
      const catchBase = clonePath(path);
      for (const thrown of sink) this.absorb(catchBase, path, thrown);
      const body = handler["body"];
      const catchFlow = isAstNode(body)
        ? await this.branch(condition, true, statementsOf(body), catchBase, ctx)
        : fallWith(catchBase, condition, true);
      result = this.merge(path, [tryFlow, catchFlow]);
    }
    const finalizer = node["finalizer"];
    if (isAstNode(finalizer) && result.term === "FALL") {
      return this.block(statementsOf(finalizer), result.path, ctx);
    }
    return result;
  }

  /** 枝を 1 つたどる（条件を経路と guard に足す）。 */
  private async branch(
    condition: PathCondition,
    holds: boolean,
    statements: readonly AstNode[],
    path: Path,
    ctx: Context,
  ): Promise<Flow> {
    const branchPath = clonePath(path);
    branchPath.conditions.push({ ...condition, holds });
    appendUnique(branchPath.unitIds, [condition.unitId]);
    ctx.guard.push({ unitId: condition.unitId, expression: condition.expression, holds });
    try {
      return await this.block(statements, branchPath, ctx);
    } finally {
      ctx.guard.pop();
    }
  }

  /**
   * 分かれた枝を 1 本の続く経路に戻す。
   * - 続く枝が無い: すべて出口なら EXIT、それ以外は JUMP
   * - 続く枝が 1 つ: その枝の経路（条件を含む）がそのまま続く
   * - 続く枝が 2 つ以上: 条件を足さず、中のユニットだけを足す
   */
  private merge(base: Path, flows: readonly Flow[]): Flow {
    const live = flows.filter((flow) => flow.term === "FALL");
    if (live.length === 0) {
      return { term: flows.every((flow) => flow.term === "EXIT") ? "EXIT" : "JUMP", path: base };
    }
    if (live.length === 1) return live[0] as Flow;
    const merged = clonePath(base);
    for (const flow of live) this.absorb(merged, base, flow.path);
    return { term: "FALL", path: merged };
  }

  /** other が base より先に通ったユニットのうち、条件と出口を除いたものを target に足す。 */
  private absorb(target: Path, base: Path, other: Path): void {
    appendUnique(
      target.unitIds,
      other.unitIds.slice(base.unitIds.length).filter((id) => INLINED_KINDS.has(this.units.get(id)?.kind ?? "")),
    );
    appendUnique(target.writes, other.writes.slice(base.writes.length));
  }

  private condition(
    ctx: Context,
    position: { line: number; column: number },
    expression: string,
    extra: Record<string, string>,
  ): PathCondition {
    const unitId = this.units.add(ctx.file.path, position, "BRANCH_CONDITION", expression, ctx.fn.symbol, { expression, ...extra });
    return { unitId, expression, holds: true };
  }

  /** 式の中の呼び出しと書き込みを、評価の順（子が先）にたどる。入れ子の関数とクラスの中には入らない。 */
  private async expression(node: unknown, path: Path, ctx: Context): Promise<void> {
    if (!isAstNode(node)) return;
    if (isCallableNode(node) || node.type === "ClassExpression" || node.type === "ClassDeclaration") return;
    for (const child of childrenOf(node)) await this.expression(child, path, ctx);
    switch (node.type) {
      case "CallExpression":
      case "OptionalCallExpression":
        await this.call(node, path, ctx);
        return;
      case "NewExpression":
        this.external(node, path, ctx, "CONSTRUCTOR");
        return;
      case "ImportExpression":
        this.external(node, path, ctx, "DYNAMIC");
        return;
      case "AssignmentExpression":
        this.write(node, node["left"], path, ctx);
        return;
      case "UpdateExpression":
        this.write(node, node["argument"], path, ctx);
        return;
      default:
        return;
    }
  }

  private async call(node: AstNode, path: Path, ctx: Context): Promise<void> {
    const position = callPosition(node);
    const signal = classifyCall(node, ctx.firebaseNames);
    if (signal === "DB_MUTATION" || signal === "EVENT_EMIT") {
      const kind = signal === "DB_MUTATION" ? "DATA_MUTATION" : "ASYNC_CUT";
      const details = callDetails(ctx.file, node);
      const id = this.units.add(ctx.file.path, position, kind, details.callee, ctx.fn.symbol, details);
      appendUnique(path.unitIds, [id]);
      if (kind === "DATA_MUTATION") appendUnique(path.writes, [id]);
      return;
    }
    const resolution = await resolveCall(this.loader, ctx.file, node, ctx.fn.className);
    if (resolution.kind === "EXTERNAL") {
      this.external(node, path, ctx, resolution.reason);
      return;
    }
    const details = callDetails(ctx.file, node);
    if (this.stack.has(refKey(resolution.ref))) {
      const id = this.units.add(ctx.file.path, position, "RECURSION", details.callee, ctx.fn.symbol, { ...details, reason: "RECURSION" });
      appendUnique(path.unitIds, [id]);
      return;
    }
    const callId = this.units.add(ctx.file.path, position, "CALL", details.callee, ctx.fn.symbol, {
      ...details,
      target: refKey(resolution.ref),
    });
    appendUnique(path.unitIds, [callId]);
    const summary = await this.summaryOf(resolution.ref);
    for (const thrown of summary.throwExits) {
      const conditions = [...path.conditions, ...thrown.conditions];
      const unitIds = [...path.unitIds];
      appendUnique(unitIds, thrown.unitIds);
      const writes = [...path.writes];
      appendUnique(writes, thrown.writes);
      if (ctx.catchSink !== null) {
        ctx.catchSink.push({ conditions, unitIds, writes });
      } else {
        ctx.exits.push({ conditions, unitIds, writes, outlet: thrown.outlet, chain: [callId, ...thrown.chain] });
      }
    }
    appendUnique(path.unitIds, summary.bodyUnits);
    appendUnique(path.writes, summary.bodyWrites);
  }

  private external(node: AstNode, path: Path, ctx: Context, reason: string): void {
    const details = callDetails(ctx.file, node);
    const id = this.units.add(ctx.file.path, callPosition(node), "EXTERNAL_CALL", details.callee, ctx.fn.symbol, { ...details, reason });
    appendUnique(path.unitIds, [id]);
  }

  private write(node: AstNode, target: unknown, path: Path, ctx: Context): void {
    if (!isAstNode(target)) return;
    const state = this.units.stateOf(ctx.file, target, ctx.fn);
    if (state === null) return;
    // guard には、その関数の中で書き込みに至る条件をすべて入れる（起点の関数でも呼ばれた関数でも同じ）。
    // 経路の条件は枝を戻すときに落ちることがある（if (a) { if (b) return; x = 1 } の !(b)）ので、
    // スライスの条件だけに任せず、書き込みの側にも残す。スライスの条件と重なることがある。
    // guard・guardHolds は人が読む用（式の原文）。M2 は guardTerms（条件のユニットの識別子と holds）を使う。
    const terms: Array<{ expression: string; holds: boolean }> = [];
    const seen = new Set<string>();
    const structured: Array<{ unitId: string; holds: boolean }> = [];
    const seenUnits = new Set<string>();
    const candidates = [...path.conditions, ...ctx.guard];
    for (const term of candidates) {
      const unitKey = `${term.holds ? "+" : "-"}${term.unitId}`;
      if (!seenUnits.has(unitKey)) {
        seenUnits.add(unitKey);
        structured.push({ unitId: term.unitId, holds: term.holds });
      }
      const key = `${term.holds ? "+" : "-"}${term.expression}`;
      if (seen.has(key)) continue;
      seen.add(key);
      terms.push({ expression: term.expression, holds: term.holds });
    }
    const { guard, guardHolds } = composeGuard(terms);
    const id = this.units.add(ctx.file.path, startOf(node), "STATE_WRITE", state.name, ctx.fn.symbol, {
      target: state.id,
      expression: sourceText(ctx.file, node),
      guard,
      guardHolds,
      guardTerms: JSON.stringify(structured),
    });
    appendUnique(path.unitIds, [id]);
    appendUnique(path.writes, [id]);
  }
}

function composeGuard(terms: ReadonlyArray<{ expression: string; holds: boolean }>): {
  guard: string | null;
  guardHolds: boolean | null;
} {
  if (terms.length === 0) return { guard: null, guardHolds: null };
  if (terms.length === 1) {
    const only = terms[0] as { expression: string; holds: boolean };
    return { guard: only.expression, guardHolds: only.holds };
  }
  return {
    guard: terms.map((term) => (term.holds ? `(${term.expression})` : `!(${term.expression})`)).join(" && "),
    guardHolds: true,
  };
}

/** 呼び出しのユニットの所在。メソッドの呼び出しはプロパティの名前の位置（a.b().c() の 2 つを分けるため）。 */
function callPosition(node: AstNode): { line: number; column: number } {
  const callee = node["callee"];
  if (isAstNode(callee) && (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression")) {
    const property = callee["property"];
    if (isAstNode(property)) return startOf(property);
  }
  return isAstNode(callee) ? startOf(callee) : startOf(node);
}

function statementsOf(node: AstNode): AstNode[] {
  if (node.type === "BlockStatement") {
    const body = node["body"];
    return Array.isArray(body) ? body.filter(isAstNode) : [];
  }
  return [node];
}

function emptyPath(): Path {
  return { conditions: [], unitIds: [], writes: [] };
}

function clonePath(path: Path): Path {
  return { conditions: [...path.conditions], unitIds: [...path.unitIds], writes: [...path.writes] };
}

function fallWith(path: Path, condition: PathCondition, holds: boolean): Flow {
  const next = clonePath(path);
  next.conditions.push({ ...condition, holds });
  appendUnique(next.unitIds, [condition.unitId]);
  return { term: "FALL", path: next };
}

function appendUnique(target: string[], ids: readonly string[]): void {
  for (const id of ids) if (!target.includes(id)) target.push(id);
}