# Specula

> **The specification layer for software engineering. Extract, formally verify, and manage specifications as the single source of truth.**

---

## 1. Vision & Core Philosophy

In modern software development, **Code** is version-controlled on **GitHub**, and **Design** is version-controlled on **Figma**. However, **Specifications** have lacked an executable, diff-aware, mathematically verifiable platform.

Specula provides the missing vertex of software engineering:

```
        【GitHub】
       Code (Engineers)
         ／        ＼
        ／          ＼
       ／            ＼
【Figma】 ─────────── 【Specula】
Design (Designers)   Specification (PdM)
```

### The Three-Actor Division of Labor
Specula operates on the fundamental principle that **LLMs must not perform logical proofs or calculations**. LLMs are probabilistic, while verification must be deterministic.

| Actor | Role | Responsibilities | Anti-patterns to Avoid |
| :--- | :--- | :--- | :--- |
| **Human (PdM / Decision Maker)** | Definition of Intent & Value | • Write scenarios & requirements in natural language / BDD.<br>• Commit & approve Domain Questions. | Exhaustive state enumeration, mathematical formalization. |
| **LLM (Agent)** | Summarizing & Translation | • Give readable names to events and operations that the parser (@babel/parser) extracted.<br>• Write counterexamples found by the solver as questions a person can answer. | Parsing code, guessing specification gaps, filling missing output with guesses, mathematical proofs. |
| **Deterministic Solver** | Bounded Model Checking | • Run the formal specification (Alloy 6) within explicit bounds (scope, temporal steps).<br>• Look for undefined transitions, overlapping operations, unreachable operations, and deadlocks. A report states the bounds it used, or says "unverified" when the engine could not be reached. | Natural language parsing, business judgment. |

---

## 2. Architecture: Ports & Adapters

The core never touches the runtime environment directly. It talks to three ports, and each environment provides its own adapters.

| Port | What it does | Node.js / CI adapter | Itera OS adapter |
| :--- | :--- | :--- | :--- |
| `FileSystemPort` | Reads and writes text files | `NodeFsAdapter` (`node:fs`) | `IteraVfsAdapter` (`MetaOS.fs`, passed in by the launcher) |
| `LanguageModelPort` | Asks an LLM for names, paraphrases, and sentences | `ClaudeCodeCli` (planned; the command line only replays records for now) | `IteraLlmAdapter` (hands each request to the Itera OS agent as an internal task and waits for the answer file) |
| `SolverPort` | Runs Alloy 6 as an external process | `CliAlloyAdapter` (Alloy 6.2.0 command line via `java`) | `LocalBridgeAlloyAdapter` (runs `java` on the user's machine through the Itera Local Bridge `/api/exec`) |

- **LLM output is recorded.** `RecordingLanguageModel` wraps a real LLM client. It stores each output under `<out>/llm_records/<sha256 of task, prompt version and input>.json` and reuses it on the next run, so a run can be repeated without calling the LLM again. Outputs that never arrived or failed the shape check are not recorded; the result says "not generated" instead of being filled with a guess.
- **The core modules M0–M5 follow the designs in `docs/design/`.** They were rewritten one module at a time, and the orchestrator (`runPipeline`) connects them. The command line and the Itera OS launcher only assemble adapters and write the outputs.

---

## 3. Build & Test

Requires Node.js 22.18 or later.

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm test            # node --test on dist/tests
npm run build:itera # bundle for Itera OS → dist/specula.itera.js
```

`dist/` is not committed. CI (GitHub Actions) runs the type check, the build, and the tests on every push and pull request. It also runs specula on itself (artifact `specula-self`) and keeps the Itera OS bundle and launcher (artifact `specula-itera`).

---

## 4. Running

### Command line (Node.js)

```sh
node dist/src/cli.js <repository dir> --out <output dir> [--alloy-jar <alloy jar>] [--records <llm records dir>]
```

Without `--alloy-jar`, verification (M3) is skipped and reported as unverified (`NO_SOLVER`). The readable outputs are written for both view roles in one run: `BUSINESS` (shown as 業務) shows no file paths, function names, line numbers or code; `IMPLEMENTATION` (shown as 実装) adds the implementation names and locations next to the same text and appends the formal specification source to each `spec.md`. Exit codes: `0` the run finished (findings and ambiguities still give 0), `1` the environment failed, `2` wrong arguments (including `--view-role`, which no longer exists).

### Itera OS

The launcher `itera/specula.html` builds the Itera adapters and runs the same pipeline. Put `dist/specula.itera.js` (from `npm run build:itera` or the `specula-itera` CI artifact) and `itera/specula.html` in the VFS, then spawn the launcher with these arguments:

| Argument | Required | Meaning |
| :--- | :--- | :--- |
| `repo` | yes | VFS directory of the repository to analyse |
| `out` | yes | VFS directory for the outputs |
| `bundle` | yes | VFS path of `specula.itera.js` |
| `jar` | no | Path of the Alloy 6.2.0 jar **on the user's machine**. Without it, M3 is skipped (`NO_SOLVER`) |
| `java` | no | `java` command on the user's machine (default `java`) |
| `connection` | no | Name of the Local Bridge connection (`connections[].name` in the `local_bridge` config). Default: the first enabled one |

- **LLM requests go to the Itera OS agent.** Each request is written to `<out>/llm_exchange/<key>.request.json` and handed to the agent with `MetaOS.ai.task`; the launcher waits (up to 5 minutes per request) for `<out>/llm_exchange/<key>.answer.txt`. Answers that pass the shape check are recorded in `<out>/llm_records`, so a second run asks nothing. An answer that failed the check is not recorded, but its file stays and is read again on the next run; delete that answer file to ask again.
- **Verification uses the Local Bridge.** The machine needs Java 17 or later, the Alloy jar, and `bash`, `mktemp` and `base64` (Linux, macOS or WSL). When the connection's `execMode` is `ask`, the launcher asks once before the run; if you decline, M3 is skipped. A model larger than about 100 KB after encoding is not sent and is reported as unreachable.
- The outputs have the same layout as the command line. The records that do not depend on the view role are at the top: `run_report.json`, `glossary.json`, `intents.json`, `implementation_map.json` (from the display ids such as `C-01` to the internal ids and the implementation), and `commands/<internal id>/…` (`spec.json`, `spec.als`, `solver_report.json` and `ledger.json`, or `ambiguity.json` for a command stopped by ambiguities). The readable outputs are under `views/business/` and `views/implementation/` with the same relative paths: `system_map.mmd` (one overview diagram), `system_map.json` (map 1, and map 2 for each bounded context with and without the supporting elements) and `commands/<internal id>/…` (`spec.md`, `matrix.md` and `flow.mmd`, or `ambiguity.md`).
- The launcher takes no `viewRole`; it stops if one is given, because both roles are written.

### Viewing the outputs in Itera OS (SpecViewer)

The launcher `itera/spec_viewer.html` shows the outputs of one run as screens: the command list (with the run summary), the command detail (specification, operation table, operation flow and, for `IMPLEMENTATION`, the formal specification source), the overall map (map 1 of the bounded contexts and map 2 of each one), the list of specification gaps (findings and ambiguities) and the glossary. It uses the same bundle and does not run the pipeline. Put `itera/spec_viewer.html` in the VFS (it is in the `specula-itera` CI artifact) and spawn it with these arguments:

| Argument | Required | Meaning |
| :--- | :--- | :--- |
| `out` | yes | VFS directory of the outputs of one run |
| `bundle` | yes | VFS path of `specula.itera.js` |
| `viewRole` | no | The role to open first: `BUSINESS` (default, shown as 業務) or `IMPLEMENTATION` (実装), in any case. Switch roles on the Global Menu |

- **The viewer refuses outputs it cannot trust** and lists the reasons instead of the screens: `run_report.json` is missing, a JSON file cannot be parsed, a file has no `basis` (outputs older than the basis) or a `basis` different from `run_report.json` (files from another run are mixed in), or a file required by a command's kind is missing. A missing optional file (for example `implementation_map.json`) only removes what depends on it, with the reason shown on that screen.
- The specification and operation table tabs show `spec.md` and `matrix.md` as written by the run for the selected role (`views/<role>/`). Outputs written before both roles were written are refused; run the pipeline again.
- Screens link to each other by display ids (`C-01`, `C-01-L-001`, `c1`, `n1`); internal ids are not shown.

---

## 5. License

MIT License © 2026 itomaAI