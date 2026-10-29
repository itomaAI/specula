// LocalBridgeAlloyAdapter のテスト（M3 の設計 3.2・3.3）。ローカルブリッジの呼び先が決まるまでは、どの依頼にも UNREACHABLE を返す。

import { test } from "node:test";
import assert from "node:assert/strict";

import { LOCAL_BRIDGE_NOT_READY, LocalBridgeAlloyAdapter } from "../src/adapters/LocalBridgeAlloyAdapter.js";

test("呼び先が決まるまでは、例外を投げずに UNREACHABLE を返す", async () => {
  const adapter = new LocalBridgeAlloyAdapter();
  const response = await adapter.run({
    source: "module x\nrun m3_cover {} for 3 but 4 Int, 1..1 steps\n",
    command: "m3_cover",
    steps: 1,
    bitwidth: 4,
    preventOverflow: true,
    timeoutMs: 1000,
  });
  assert.deepEqual(response, { kind: "UNREACHABLE", detail: LOCAL_BRIDGE_NOT_READY });
});