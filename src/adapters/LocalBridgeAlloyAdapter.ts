// ローカルブリッジ経由で、手元の PC の Alloy 6 を起動するアダプター（M3 の設計 3.2）。
//
// ブラウザ（Itera OS）の中では Java 製の Alloy を動かせないため、手元の PC の `java` を使う。
// ローカルブリッジのどの口を呼ぶかは、まだ決まっていない（設計 3.3）。決まるまでは、どの依頼にも UNREACHABLE を返す。
// コアはこれを「エンジンに届かない」として扱い、M3 は UNVERIFIED になる（検査の結果を作らない）。
// 口が決まったら、CliAlloyAdapter と同じ呼び方（exec -f -q [-n] -s -c -o -t json）をブリッジ越しに行い、
// receipt.json の読み取りは CliAlloyAdapter と共通にする。

import type { SolverPort, SolverRequest, SolverResponse } from "../ports/SolverPort.js";

export const LOCAL_BRIDGE_NOT_READY = "LocalBridgeAlloyAdapter: ローカルブリッジの呼び先がまだ決まっていない（M3 の設計 3.3）";

export class LocalBridgeAlloyAdapter implements SolverPort {
  async run(_request: SolverRequest): Promise<SolverResponse> {
    return { kind: "UNREACHABLE", detail: LOCAL_BRIDGE_NOT_READY };
  }
}