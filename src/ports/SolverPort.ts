// Alloy 6 を実行する口（M3 の設計 3.1）。
// アダプター（CliAlloyAdapter・LocalBridgeAlloyAdapter）は例外を投げず、届かないことも値で返す。

export interface SolverRequest {
  /** M2 のソースに M3 のコマンドを足したもの。 */
  source: string;
  /** 実行するコマンドの名前（"m3_cover" など）。 */
  command: string;
  /** このときのステップ数の上限。 */
  steps: number;
  bitwidth: number;
  preventOverflow: boolean;
  timeoutMs: number;
}

export interface EngineInfo {
  alloyVersion: string;
  satSolver: string;
  satSolverVersion: string | null;
}

/**
 * エンジンが出した実例。時点ごとに、各フィールドの値を原子の名前の組で表す。
 * 形はアダプターがそろえ、コアは Alloy の出力の書式を知らない。
 * 注: 形は仮。M3 を書き直すとき、実際の Alloy の出力を見て確定する（M3 の設計 3.3）。
 */
export interface RawInstance {
  /** 時点 0 から順に。各時点はフィールド名 → 原子の名前の組の並び。 */
  states: Array<Record<string, string[][]>>;
  /** 実例の最後の時点のあと、どの時点に戻るか（Alloy 6 の時相の実例は輪で終わる）。分からなければ null。 */
  loopBack: number | null;
}

export type SolverResponse =
  | { kind: "UNSAT"; engine: EngineInfo }
  | { kind: "SAT"; engine: EngineInfo; instance: RawInstance }
  | { kind: "ENGINE_ERROR"; engine: EngineInfo | null; message: string }
  | { kind: "UNREACHABLE"; detail: string }
  | { kind: "TIMEOUT"; engine: EngineInfo | null };

export interface SolverPort {
  run(request: SolverRequest): Promise<SolverResponse>;
}