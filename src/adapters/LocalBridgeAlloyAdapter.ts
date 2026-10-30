// SolverPort の Itera OS 版（M3 の設計 3.2・3.4、全体設計 4.1）。
// ローカルブリッジのサーバーの `POST <serverUrl>/api/exec` を通して、手元の PC の `java` で Alloy 6 を起動する。
// ブラウザ（Itera OS）の中では Java 製の Alloy を動かせないためである。
//
// - exec にはファイルを渡す口が無いので、ソースは base64 にしてコマンドの文字列に埋める。
//   コマンドは一時ディレクトリを作ってソースを書き出し、CliAlloyAdapter と同じ形で `exec` を動かし、
//   終了コードを目印の行で出してから receipt.json を出す。実例は receipt.json の `solution` に入っているので、実例のファイルは読まない。
// - receipt の読み取りと、誤りのときの message の取り出しは、CliAlloyAdapter と同じ関数を使う。
// - fetch・サーバーの URL・jar・java・SAT ソルバは引数で受け、MetaOS を参照しない。
// - `execMode: "ask"` の確認は起動アプリが実行の前に 1 回だけ行う。このアダプターは確かめない。
// - 例外は投げず、届かないことも値で返す（SolverPort の約束）。
//
// 前提: 手元の PC に bash・mktemp・base64 がある（Linux・macOS・WSL）。

import type { EngineInfo, SolverPort, SolverRequest, SolverResponse } from "../ports/SolverPort.js";
import { errorMessage, interpretReceipt } from "./CliAlloyAdapter.js";

/** fetch の、このアダプターが使う部分だけ。起動アプリは `window.fetch` をそのまま渡せる。 */
export interface BridgeFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type BridgeFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<BridgeFetchResponse>;

export interface LocalBridgeAlloyOptions {
  fetch: BridgeFetch;
  /** ローカルブリッジのサーバー（例 "http://127.0.0.1:8001"）。起動アプリが Itera OS の設定 `local_bridge` から読んで渡す。 */
  serverUrl: string;
  /** 手元の PC での Alloy の jar（org.alloytools.alloy.dist.jar）のパス。 */
  jarPath: string;
  /** 手元の PC での java のコマンド。既定は "java"。 */
  javaPath?: string;
  /** SAT ソルバの名前。既定は "sat4j"。 */
  satSolver?: string;
}

/** Linux では 1 つの引数が 128 KiB まで（MAX_ARG_STRLEN）なので、それより小さいところで止める（設計 3.4）。 */
export const MAX_COMMAND_BYTES = 100_000;
const MAX_BRIDGE_TIMEOUT_S = 600;
const CLIENT_GRACE_MS = 30_000;
const VERSION_TIMEOUT_MS = 30_000;
const BRIDGE_TIMEOUT_EXIT = 124;
const EXIT_MARK = /^<<<SPECULA-EXIT (\d+)>>>$/m;

/** ブリッジの exec の結果。通信の段で決まるものと、コマンドが終わったものを分ける。 */
export type BridgeExecResult =
  | { kind: "DONE"; exitCode: number; stdout: string; stderr: string }
  | { kind: "UNREACHABLE"; detail: string }
  | { kind: "TIMEOUT" };

type VersionResult = { ok: true; version: string } | { ok: false; response: SolverResponse };

export class LocalBridgeAlloyAdapter implements SolverPort {
  private readonly javaPath: string;
  private readonly satSolver: string;
  private version: Promise<VersionResult> | null = null;

  constructor(private readonly options: LocalBridgeAlloyOptions) {
    this.javaPath = options.javaPath ?? "java";
    this.satSolver = options.satSolver ?? "sat4j";
  }

  async run(request: SolverRequest): Promise<SolverResponse> {
    const version = await this.alloyVersion();
    if (!version.ok) return version.response;
    const engine: EngineInfo = { alloyVersion: version.version, satSolver: this.satSolver, satSolverVersion: null };

    const command = buildExecCommand(request, { javaPath: this.javaPath, jarPath: this.options.jarPath, satSolver: this.satSolver });
    const bytes = new TextEncoder().encode(command).length;
    if (bytes > MAX_COMMAND_BYTES) {
      return { kind: "UNREACHABLE", detail: `コマンドが大きすぎるので送らなかった: ${bytes} バイト（上限 ${MAX_COMMAND_BYTES} バイト）` };
    }
    const result = await this.exec(command, request.timeoutMs);
    if (result.kind === "UNREACHABLE") return { kind: "UNREACHABLE", detail: result.detail };
    if (result.kind === "TIMEOUT") return { kind: "TIMEOUT", engine };
    return interpretExecOutput(result, request, engine);
  }

  /** `'<java>' -jar '<jar>' version` の出力。アダプターごとに 1 回だけ取る（失敗したら次の呼び出しでやり直す）。 */
  private alloyVersion(): Promise<VersionResult> {
    if (this.version === null) {
      this.version = (async (): Promise<VersionResult> => {
        const command = `${shellQuote(this.javaPath)} -jar ${shellQuote(this.options.jarPath)} version`;
        const result = await this.exec(command, VERSION_TIMEOUT_MS);
        if (result.kind === "UNREACHABLE") return { ok: false, response: { kind: "UNREACHABLE", detail: result.detail } };
        if (result.kind === "TIMEOUT" || result.exitCode === BRIDGE_TIMEOUT_EXIT) {
          return { ok: false, response: { kind: "TIMEOUT", engine: null } };
        }
        const missing = missingJava(result.exitCode, `${result.stderr}\n${result.stdout}`);
        if (missing !== null) return { ok: false, response: { kind: "UNREACHABLE", detail: missing } };
        const line = result.stdout.split(/\r?\n/).map((text) => text.trim()).find((text) => /^\d+\.\d+/.test(text));
        if (result.exitCode !== 0 || line === undefined) {
          return {
            ok: false,
            response: {
              kind: "ENGINE_ERROR",
              engine: null,
              message: `Alloy の版を読めない: ${errorMessage(result.stdout, result.stderr, result.exitCode)}`,
            },
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

  /** ブリッジの /api/exec を 1 回呼ぶ。ブリッジの時間切れは ceil(timeoutMs / 1000) 秒（上限 600）、こちらは 30 秒の余裕を足して待つ。 */
  private async exec(command: string, timeoutMs: number): Promise<BridgeExecResult> {
    const url = `${this.options.serverUrl.replace(/\/+$/, "")}/api/exec`;
    const timeout = Math.min(MAX_BRIDGE_TIMEOUT_S, Math.max(1, Math.ceil(timeoutMs / 1000)));
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs + CLIENT_GRACE_MS);
    try {
      const response = await this.options.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, scope: "host", timeout }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const note = response.status === 403 ? "（exec を止めて起動したサーバー）" : "";
        return { kind: "UNREACHABLE", detail: `ローカルブリッジが HTTP ${response.status} を返した${note}` };
      }
      const body = await response.json();
      return toExecResult(body);
    } catch (error) {
      if (timedOut) return { kind: "TIMEOUT" };
      return { kind: "UNREACHABLE", detail: `ローカルブリッジに届かない: ${describe(error)}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 1 回の依頼を、ブリッジに渡す 1 本のコマンドにする（設計 3.4）。純粋な関数。 */
export function buildExecCommand(
  request: SolverRequest,
  options: { javaPath: string; jarPath: string; satSolver: string },
): string {
  const args = ["-jar", shellQuote(options.jarPath), "exec", "-f", "-q"];
  if (request.preventOverflow) args.push("-n");
  args.push("-s", shellQuote(options.satSolver), "-c", shellQuote(request.command), "-o", '"$d/out"', "-t", "json", '"$d/model.als"');
  return [
    "d=$(mktemp -d) || exit 70",
    `trap 'rm -rf "$d"' EXIT`,
    `printf '%s' '${base64Utf8(request.source)}' | base64 -d > "$d/model.als"`,
    `${shellQuote(options.javaPath)} ${args.join(" ")}`,
    'echo "<<<SPECULA-EXIT $?>>>"',
    'cat "$d/out/receipt.json" 2>/dev/null',
  ].join("\n");
}

/**
 * ブリッジの結果を SolverResponse にする（設計 3.4 の表）。純粋な関数。
 * 目印の行の前が Alloy 自身の出力、後ろが receipt.json である。
 */
export function interpretExecOutput(
  result: { exitCode: number; stdout: string; stderr: string },
  request: SolverRequest,
  engine: EngineInfo,
): SolverResponse {
  if (result.exitCode === BRIDGE_TIMEOUT_EXIT) return { kind: "TIMEOUT", engine };
  const mark = EXIT_MARK.exec(result.stdout);
  if (mark === null || mark[1] === undefined) {
    return {
      kind: "ENGINE_ERROR",
      engine,
      message: `ブリッジの出力に終了コードの目印が無い: ${errorMessage(result.stdout, result.stderr, result.exitCode)}`,
    };
  }
  const javaExit = Number(mark[1]);
  const alloyOutput = result.stdout.slice(0, mark.index);
  const receipt = result.stdout.slice(mark.index + mark[0].length).trim();
  const missing = missingJava(javaExit, `${result.stderr}\n${alloyOutput}`);
  if (missing !== null) return { kind: "UNREACHABLE", detail: missing };
  if (javaExit !== 0) return { kind: "ENGINE_ERROR", engine, message: errorMessage(alloyOutput, result.stderr, javaExit) };
  if (receipt === "") {
    return { kind: "ENGINE_ERROR", engine, message: `receipt.json が無い（コマンド ${request.command} が実行されていない）` };
  }
  return interpretReceipt(receipt, request, engine);
}

/** java が無い（127）、または jar を開けないときの理由。どちらでもなければ null。 */
function missingJava(exitCode: number, output: string): string | null {
  if (exitCode === 127) return "手元の PC で java を起動できない（終了コード 127）";
  if (/Unable to access jarfile/.test(output)) return "手元の PC で Alloy の jar を開けない（Unable to access jarfile）";
  return null;
}

function toExecResult(body: unknown): BridgeExecResult {
  if (typeof body !== "object" || body === null) return { kind: "UNREACHABLE", detail: "ローカルブリッジの返り値が JSON のオブジェクトでない" };
  const { exitCode, stdout, stderr } = body as Record<string, unknown>;
  if (typeof exitCode !== "number" || typeof stdout !== "string" || typeof stderr !== "string") {
    return { kind: "UNREACHABLE", detail: "ローカルブリッジの返り値に exitCode・stdout・stderr がそろっていない" };
  }
  return { kind: "DONE", exitCode, stdout, stderr };
}

/** bash の単一引用符で囲む。中の ' は '\'' にする。 */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 文字列を UTF-8 にして base64 にする（Node.js とブラウザの両方で同じ結果になるよう、自分で書く）。 */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += BASE64.charAt((n >> 18) & 63);
    out += BASE64.charAt((n >> 12) & 63);
    out += b1 === undefined ? "=" : BASE64.charAt((n >> 6) & 63);
    out += b2 === undefined ? "=" : BASE64.charAt(n & 63);
  }
  return out;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}