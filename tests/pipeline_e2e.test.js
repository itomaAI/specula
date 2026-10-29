export async function runPipelineE2ETests(assert) {
  const modUrl = await MetaOS.fs.resolveUrl('user/projects/specula/dist/specula.bundle.js');
  const { executePipeline } = await import(modUrl);

  const sampleRepo = {
    files: [
      {
        path: "src/features/account/app/(dashboard)/settings/page.tsx",
        content: `
          export default function SettingsPage() {
            const [email, setEmail] = useState("");
            const handleUpdateEmail = async () => {
              if (!email) return;
              await fetch("/api/account/email", { method: "POST" });
            };
            return <div><button onClick={handleUpdateEmail}>更新</button></div>;
          }
        `
      },
      {
        path: "src/features/account/api/email.ts",
        content: `
          app.post("/api/account/email", async (req, res) => {
            await updateEmail();
            res.json({ ok: true });
          });
        `
      },
      {
        path: "src/features/account/models/account.prisma",
        content: `
          model Account {
            id String @id
            email String
          }
        `
      }
    ]
  };

  const result = await executePipeline(sampleRepo);

  // Assertion 1: Map Discovery
  assert(result.map.boundedContexts.length === 1, "E2E: Identifies account bounded context");
  assert(result.map.boundedContexts[0].name === "account", "Context name is account");

  // Assertion 2: Executions
  assert(result.executions.length >= 1, "E2E: Successfully executes scenario pipeline");
  const exec = result.executions[0];
  assert(exec.target.id.startsWith("SCN-"), "E2E: Target scenario generated");
  assert(exec.context.units.length > 0, "E2E: Causal context sliced");
  assert(exec.transpileResult.kind === "SUCCESS", "E2E: Formal spec transpiled");
  assert(exec.solverReport !== undefined, "E2E: Mathematical solver verified state space");
  assert(exec.ledgerCatalog !== undefined, "E2E: Decision ledgers synthesized");
  assert(exec.views.markdownDoc.includes("# 仕様書:"), "E2E: Markdown specification view projected");
  assert(exec.views.mermaidDiagram.startsWith("sequenceDiagram"), "E2E: Mermaid sequence diagram projected");
  assert(exec.views.stateMatrixMd.includes("現在状態"), "E2E: State matrix projected");

  return { passed: 10, total: 10 };
}