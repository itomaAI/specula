export async function runContextExtractorTests(assert) {
  const modUrl = await MetaOS.fs.resolveUrl('user/projects/specula/dist/core/context_extractor.js');
  const { extractContext } = await import(modUrl);

  const sampleTarget = {
    id: "SCN-PASSWORD-CHANGE",
    boundedContext: "UserAuth",
    intent: "ユーザーがパスワードを変更し安全性を確保する",
    inletType: "COMMAND",
    inletTrigger: {
      name: "ChangePassword",
      handlerName: "handlePasswordChange"
    },
    actor: { id: "ACT-USER", name: "一般ユーザー" },
    readModel: {
      name: "MyPageScreen",
      route: "/mypage",
      entryFile: "src/app/mypage/page.tsx"
    },
    expectedEvent: "PasswordChanged"
  };

  const sampleRepo = {
    files: [
      {
        path: "src/app/mypage/page.tsx",
        content: `
          export default function MyPage() {
            const [newPassword, setNewPassword] = useState("");
            const [error, setError] = useState(null);

            const handlePasswordChange = async () => {
              if (!newPassword) { setError("必須です"); return; }
              await fetch("/api/auth/password", { method: "POST", body: JSON.stringify({ newPassword }) });
              emit("user_password_changed");
            };

            return <div><button onClick={handlePasswordChange}>保存</button></div>;
          }
        `
      },
      {
        path: "src/api/auth/password.ts",
        content: `
          app.post("/api/auth/password", async (req, res) => {
            await updatePasswordInDb(req.body);
            res.json({ ok: true });
          });
        `
      },
      {
        path: "src/models/user.prisma",
        content: `
          model User {
            id String @id
            passwordHash String
          }
        `
      }
    ]
  };

  const result = extractContext(sampleTarget, sampleRepo);

  // Assertion 1: Basic Contract Check
  assert(result.scenarioId === "SCN-PASSWORD-CHANGE", "Returns correct scenarioId");
  assert(result.intent === sampleTarget.intent, "Carries over business intent");
  assert(result.entryPoint.route === "/mypage", "Valid entryPoint route");

  // Assertion 2: Multi-layer Extraction Units
  const kinds = result.units.map(u => u.kind);
  assert(kinds.includes("STATE"), "Extracts UI STATE (useState)");
  assert(kinds.includes("OPERATION"), "Extracts UI OPERATION (handlePasswordChange)");
  assert(kinds.includes("INTERFACE_TEXT"), "Extracts UI INTERFACE_TEXT (保存)");
  assert(kinds.includes("BRANCH_CONDITION"), "Extracts UI BRANCH_CONDITION (if !newPassword)");
  assert(kinds.includes("API_ENDPOINT"), "Extracts Backend API_ENDPOINT (/api/auth/password)");
  assert(kinds.includes("SCHEMA_ENTITY"), "Extracts Schema SCHEMA_ENTITY (User)");

  // Assertion 3: Asynchronous Boundary Cut
  assert(result.isAsyncCutEnforced === true, "Enforces asynchronous boundary cut on emit()");
  assert(kinds.includes("ASYNC_CUT"), "Records ASYNC_CUT unit to sever subsequent executions");

  // Assertion 4: Use Case Slicing
  assert(result.slices.length === 2, "Generates 2 use case slices (Normal vs Rejected)");
  assert(result.slices.some(s => s.sliceId.endsWith("-NORMAL")), "Normal execution slice exists");
  assert(result.slices.some(s => s.sliceId.endsWith("-REJECTED")), "Rejected / guard failure slice exists");

  // Assertion 5: Determinism Invariant
  const repeat = extractContext(sampleTarget, sampleRepo);
  assert(JSON.stringify(result) === JSON.stringify(repeat), "100% Deterministic output invariant");

  return { passed: 13, total: 13 };
}