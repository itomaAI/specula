// SolverPort の CLI 版（M3 の設計 3.1・3.3）。Alloy 6.2.0 の `java -jar <jar> exec` を子プロセスで呼ぶ。
//
// CLI の振る舞い（2026-10-30 に CI の試しのジョブで確かめた。Alloy 6.2.0・Temurin 17）:
// - `exec -f -q [-n] -s <ソルバ> -c <コマンド> -o <ディレクトリ> -t json <ファイル>` で、出力先に receipt.json と
//   `<コマンド>-solution-0.json` を作る。`-n` はあふれのある実例を除く。時間切れの選択肢は無い。
// - 反例・実例が無いとき（UNSAT）は終了コード 0 で、receipt.json のそのコマンドに `solution` が無い。
// - 構文の誤り・知らない名前・知らないソルバは終了コード 1（出力先は作られない）。
// - 知らないコマンド名は終了コード 0 で、出力先は空（receipt.json も無い）。UNSAT と取り違えないよう ENGINE_ERROR にする。
// - 実例の各時点は `{ state, values }`。receipt では時点 0 の `state` が省かれる。values は
//   `"System$0": { "v1": [["False$0"]] }` の形で、整数も文字列（"-8"）。輪の戻り先（loopstate）は JSON では -1 のままなので使わない。
//
// node: のモジュールは使うときに import する（NodeFsAdapter と同じ理由。Itera 向けの bundle で失敗しないため）。
// 例外は投げず、届かないことも値で返す（SolverPort の約束）。

import type { EngineInfo, RawInstance, SolverPort, SolverRequest, SolverResponse } from "../ports/SolverPort.js";

export interface CliAlloyOptions {
  /** Alloy の jar（org.alloytools.alloy.dist.jar）のパス。 */
  jarPath: string;
  /** java のコマンド。既定は "java"。 */
  javaPath?: string;
  /** SAT ソルバの名前（`java -jar <jar> solvers` の id）。既定は "sat4j"。 */
  satSolver?: string;
}

const OUTPUT_LIMIT = 1_000_000;
const VERSION_TIMEOUT_MS = 30_000;

type ProcessResult =
  | { kind: "EXITED"; code: number | null; stdout: string; stderr: string }
  | { kind: "TIMEOUT" }
  | { kind: "SPAWN_ERROR"; message: string };

type VersionResult = { ok: true; version: string } | { ok: false; response: SolverResponse };

export class CliAlloyAdapter implements SolverPort {
  private readonly javaPath: string;
  private readonly satSolver: string;
  private version: Promise<VersionResult> | null = null;

  constructor(private readonly options: CliAlloyOptions) {
    this.javaPath = options.javaPath ?? "java";
    this.satSolver = options.satSolver ?? "sat4j";
  }

  async run(request: SolverRequest): Promise<SolverResponse> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");

    try {
      await fs.stat(this.options.jarPath);
    } catch {
      return { kind: "UNREACHABLE", detail: `Alloy の jar が無い: ${this.options.jarPath}` };
    }
    const version = await this.alloyVersion();
    if (!version.ok) return version.response;
    const engine: EngineInfo = { alloyVersion: version.version, satSolver: this.satSolver, satSolverVersion: null };

    let dir: string | null = null;
    try {
      dir = await fs.mkdtemp(nodePath.join(os.tmpdir(), "specula-m3-"));
      const modelPath = nodePath.join(dir, "model.als");
      const outDir = nodePath.join(dir, "out");
      await fs.writeFile(modelPath, request.source, "utf8");
      const args = ["-jar", this.options.jarPath, "exec", "-f", "-q"];
      if (request.preventOverflow) args.push("-n");
      args.push("-s", this.satSolver, "-c", request.command, "-o", outDir, "-t", "json", modelPath);

      const result = await runProcess(this.javaPath, args, request.timeoutMs, dir);
      if (result.kind === "SPAWN_ERROR") return { kind: "UNREACHABLE", detail: `java を起動できない: ${result.message}` };
      if (result.kind === "TIMEOUT") return { kind: "TIMEOUT", engine };
      if (result.code !== 0) {
        return { kind: "ENGINE_ERROR", engine, message: errorMessage(result.stdout, result.stderr, result.code) };
      }

      let receipt: string;
      try {
        receipt = await fs.readFile(nodePath.join(outDir, "receipt.json"), "utf8");
      } catch {
        return { kind: "ENGINE_ERROR", engine, message: `receipt.json が無い（コマンド ${request.command} が実行されていない）` };
      }
      return interpretReceipt(receipt, request, engine);
    } catch (error) {
      return { kind: "ENGINE_ERROR", engine, message: `CLI の呼び出しに失敗した: ${describe(error)}` };
    } finally {
      if (dir !== null) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** `java -jar <jar> version` の出力。プロセスごとに 1 回だけ呼ぶ（失敗したら次の呼び出しでやり直す）。 */
  private alloyVersion(): Promise<VersionResult> {
    if (this.version === null) {
      this.version = (async (): Promise<VersionResult> => {
        const result = await runProcess(this.javaPath, ["-jar", this.options.jarPath, "version"], VERSION_TIMEOUT_MS, undefined);
        if (result.kind === "SPAWN_ERROR") {
          return { ok: false, response: { kind: "UNREACHABLE", detail: `java を起動できない: ${result.message}` } };
        }
        if (result.kind === "TIMEOUT") return { ok: false, response: { kind: "TIMEOUT", engine: null } };
        const line = result.stdout.split(/\r?\n/).map((text) => text.trim()).find((text) => /^\d+\.\d+/.test(text));
        if (result.code !== 0 || line === undefined) {
          return {
            ok: false,
            response: { kind: "ENGINE_ERROR", engine: null, message: `Alloy の版を読めない: ${errorMessage(result.stdout, result.stderr, result.code)}` },
          };
        }
        return { ok: true, version: line };
      })();
      this.version.then((value) => {
        if (!value.ok) this.version = null;
      });
    }
    return this.version;
  }
}

/**
 * receipt.json を SolverResponse にする。純粋な関数（テストで試しのジョブの receipt をそのまま渡せる）。
 * 実例が無いことは `solution` が無いこと。コマンドが無い・範囲が依頼と違う・形が違うときは ENGINE_ERROR。
 */
export function interpretReceipt(receiptText: string, request: SolverRequest, engine: EngineInfo): SolverResponse {
  let receipt: unknown;
  try {
    receipt = JSON.parse(receiptText);
  } catch (error) {
    return { kind: "ENGINE_ERROR", engine, message: `receipt.json を JSON として読めない: ${describe(error)}` };
  }
  const solver = field(receipt, "solver");
  const actualEngine: EngineInfo = typeof solver === "string" ? { ...engine, satSolver: solver } : engine;
  const command = field(field(receipt, "commands"), request.command);
  if (!isObject(command)) {
    return { kind: "ENGINE_ERROR", engine: actualEngine, message: `receipt.json にコマンド ${request.command} が無い` };
  }
  const bitwidth = field(command, "bitwidth");
  const maxprefix = field(command, "maxprefix");
  if (bitwidth !== request.bitwidth || maxprefix !== request.steps) {
    return {
      kind: "ENGINE_ERROR",
      engine: actualEngine,
      message: `範囲が依頼と違う: bitwidth ${String(bitwidth)}（依頼 ${request.bitwidth}）、ステップ数 ${String(maxprefix)}（依頼 ${request.steps}）`,
    };
  }
  const solution = field(command, "solution");
  if (solution === undefined || (Array.isArray(solution) && solution.length === 0)) return { kind: "UNSAT", engine: actualEngine };
  if (!Array.isArray(solution)) return { kind: "ENGINE_ERROR", engine: actualEngine, message: "solution が配列でない" };
  try {
    return { kind: "SAT", engine: actualEngine, instance: toRawInstance(solution[0]) };
  } catch (error) {
    return { kind: "ENGINE_ERROR", engine: actualEngine, message: describe(error) };
  }
}

/** solution の 1 件を RawInstance にする。`"System$0": { "v1": … }` を `"System.v1"` にまとめる（組の中の原子の名前はそのまま）。 */
export function toRawInstance(solution: unknown): RawInstance {
  const instances = field(solution, "instances");
  if (!Array.isArray(instances) || instances.length === 0) throw new Error("実例に時点が無い");
  const states = instances.map((instance, index) => {
    const state = field(instance, "state");
    if (state !== undefined && state !== index) throw new Error(`時点の番号が順でない: ${String(state)}（${index} 番目）`);
    const values = field(instance, "values");
    if (!isObject(values)) throw new Error(`時点 ${index} に values が無い`);
    const out: Record<string, string[][]> = {};
    for (const [atom, fields] of Object.entries(values)) {
      if (!isObject(fields)) throw new Error(`時点 ${index} の ${atom} の値が想定の形でない`);
      const sig = atom.replace(/\$\d+$/, "");
      for (const [name, tuples] of Object.entries(fields)) {
        const key = `${sig}.${name}`;
        out[key] = [...(out[key] ?? []), ...toTuples(tuples, `時点 ${index} の ${key}`)];
      }
    }
    return out;
  });
  return { states, loopBack: null };
}

function toTuples(value: unknown, where: string): string[][] {
  if (!Array.isArray(value)) throw new Error(`${where} が組の並びでない`);
  return value.map((tuple) => {
    if (!Array.isArray(tuple)) throw new Error(`${where} の組が配列でない`);
    return tuple.map((atom) => {
      if (typeof atom === "string") return atom;
      if (typeof atom === "number" && Number.isInteger(atom)) return String(atom);
      throw new Error(`${where} の原子が文字列でない: ${JSON.stringify(atom)}`);
    });
  });
}

/** 誤りのときの出力から、`Syntax error` などの行とその次の行を取り出す。見つからなければ末尾の数行。 */
export function errorMessage(stdout: string, stderr: string, code: number | null): string {
  const lines = `${stderr}\n${stdout}`.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  const at = lines.findIndex((line) => /Syntax error|Type error|No such solver|Exception/.test(line));
  const picked = at >= 0 ? lines.slice(at, at + 2) : lines.slice(-5);
  const text = picked.join(" / ").replace(/^\[main\] ERROR alloy - /, "");
  return `終了コード ${String(code)}: ${text.slice(0, 2000)}`;
}

async function runProcess(command: string, args: string[], timeoutMs: number, cwd: string | undefined): Promise<ProcessResult> {
  const childProcess = await import("node:child_process");
  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = "";
    let stderr = "";
    let child: import("node:child_process").ChildProcess;
    try {
      child = childProcess.spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ kind: "SPAWN_ERROR", message: describe(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "TIMEOUT" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ kind: "SPAWN_ERROR", message: describe(error) }));
    child.on("close", (code) => finish({ kind: "EXITED", code, stdout, stderr }));
  });
}

function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}