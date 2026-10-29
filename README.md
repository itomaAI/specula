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
| `LanguageModelPort` | Asks an LLM for names, paraphrases, and sentences | `ClaudeCodeCli` (planned) | `IteraLlm` (planned) |
| `SolverPort` | Runs Alloy 6 as an external process | `CliAlloy` (Alloy 6.2.0 command line via `java`) | `LocalBridgeAlloy` (returns UNREACHABLE until the bridge endpoint is decided) |

- **LLM output is recorded.** `RecordingLanguageModel` wraps a real LLM client. It stores each output under `llm-records/<sha256 of task, prompt version and input>.json` and reuses it on the next run, so a run can be repeated without calling the LLM again. Outputs that never arrived or failed the shape check are not recorded; the result says "not generated" instead of being filled with a guess.
- **The core modules M0–M5 are being rewritten one at a time** (see `docs/design/`). This stage contains only the shared foundation: the ports, the LLM recording, and the build.

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

`dist/` is not committed. CI (GitHub Actions) runs the type check, the build, and the tests on every push and pull request.

---

## 4. License

MIT License © 2026 itomaAI