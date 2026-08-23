#!/usr/bin/env node
/**
 * Typecheck every ```ts sample in the SDK guide against the built packages.
 *
 * "The SDK guide" is `sdk.md` plus every focused `sdk-*.md` page (agent
 * options, events, tools, permissions, sessions, models, advanced) — each
 * page's samples are held to the same bar. Doc fragments assume surrounding
 * context (an `agent`, earlier imports, an elided `// ...` of required
 * options); this harness declares that context and splices a typed `base`
 * into elided `createAgent` calls, then runs the repo's TypeScript over the
 * result. A sample using an event name, option, or field that does not exist
 * in the real types fails the check — the docs cannot drift from the API.
 *
 * Run directly (`node scripts/check-sdk-docs.mjs`) or via `npm run check`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsDir = join(root, "web/content/docs");
// sdk.md plus every focused sdk-*.md page (agent options, events, tools,
// permissions, sessions, models, advanced) — the guide is split across pages,
// but every ```ts sample anywhere in it is held to the same bar.
const docFiles = ["sdk.md", ...readdirSync(docsDir).filter((f) => /^sdk-.*\.md$/.test(f))].sort();
const blocks = docFiles.flatMap((file) => {
  const doc = readFileSync(join(docsDir, file), "utf8");
  return [...doc.matchAll(/```ts\n(.*?)```/gs)].map((m) => ({ file, code: m[1] }));
});

const AMBIENT = [
  ["createAgent", "declare const createAgent: typeof import('@arcturn/core').createAgent;"],
  ["requireModel", "declare const requireModel: typeof import('@arcturn/ai').requireModel;"],
  ["presetModel", "declare const presetModel: typeof import('@arcturn/ai').presetModel;"],
  ["createClient", "declare const createClient: typeof import('@arcturn/ai').createClient;"],
  ["agent", "declare const agent: import('@arcturn/core').Agent;"],
  ["tools", "declare const tools: import('@arcturn/types').Tool[];"],
  ["llm", "declare const llm: import('@arcturn/types').LLMClient;"],
  ["model", "declare const model: import('@arcturn/types').ModelSpec;"],
  ["systemPrompt", "declare const systemPrompt: string;"],
  ["cwd", "declare const cwd: string;"],
  ["store", "declare const store: import('@arcturn/core').JsonlSessionStore;"],
  ["sessionId", "declare const sessionId: string;"],
  ["auditLog", "declare const auditLog: { write(entry: unknown): void };"],
  [
    "runDeploy",
    "declare function runDeploy(env: string, opts: { signal: AbortSignal }): Promise<string>;",
  ],
  [
    "showApprovalDialog",
    "declare function showApprovalDialog(request: unknown): Promise<boolean>;",
  ],
  ["assertUnhandled", "declare function assertUnhandled(event: unknown): void;"],
  ["log", "declare function log(x: unknown): void;"],
  ["renderDelta", "declare function renderDelta(event: unknown): void;"],
  ["syncSidebar", "declare function syncSidebar(todos: unknown): void;"],
  ["trace", "declare function trace(id: string, type: string): void;"],
  ["report", "declare function report(message: string | undefined): void;"],
  [
    "readSomething",
    "declare function readSomething(path: string, signal: AbortSignal): Promise<string>;",
  ],
  ["usage", "declare const usage: import('@arcturn/types').Usage;"],
  ["someOlderEntryId", "declare const someOlderEntryId: string;"],
];

const dir = mkdtempSync(join(tmpdir(), "arcturn-sdk-docs-"));
try {
  blocks.forEach(({ file, code }, i) => {
    const body = code
      // elided required options become a typed base
      .replace(
        /createAgent\(\{\n(\s*)\/\/ \.\.\.\n/g,
        (_, pad) => `createAgent({\n${pad}...base,\n`,
      )
      .replace(/createAgent\(\{ \/\* … \*\//g, "createAgent({ ...base,")
      // the exhaustiveness fragment elides its cases on purpose
      .replace("event satisfies never;", "assertUnhandled(event);")
      .replace(/^\s*\/\/ \.\.\.every case\.\.\.\n/m, "");
    const decls = [];
    if (body.includes("...base,")) {
      decls.push("declare const base: import('@arcturn/core').AgentOptions;");
    }
    for (const [name, decl] of AMBIENT) {
      const used = new RegExp(`\\b${name}\\b`).test(body);
      const declared =
        new RegExp(`\\b(?:const|let|function)\\s+${name}\\b`).test(body) ||
        new RegExp(`import[^\\n]*\\b${name}\\b`).test(body) ||
        new RegExp(`\\{\\s*${name}\\s*\\}\\s*=`).test(body);
      if (used && !declared) decls.push(decl);
    }
    writeFileSync(
      join(dir, `block${String(i).padStart(2, "0")}.ts`),
      `/* ${file} sample ${i} */\n${decls.join("\n")}\n${body}\nexport {};\n`,
    );
  });

  const paths = {};
  for (const pkg of ["core", "ai", "tools", "types", "mcp"]) {
    paths[`@arcturn/${pkg}`] = [join(root, `packages/${pkg}/dist/index.d.ts`)];
  }
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
          paths,
        },
        include: ["*.ts"],
      },
      null,
      2,
    ),
  );

  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", dir], {
    stdio: "inherit",
  });
  console.log(
    `sdk docs: ${blocks.length} samples across ${docFiles.length} pages typecheck against the built packages`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
