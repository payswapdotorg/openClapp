import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  ComputerService,
  computerIdentity,
  type DockerResult,
  type DockerRunner,
} from "../apps/server/src/computer.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { ClappStage } from "../packages/clapp-contracts/src/index.ts";
import {
  CLAPP_STAGES,
  ClappHandleNotProvidedError,
  ClappNotConfiguredError,
  ClappRuntimeError,
  candidateSeamOf,
  createClappTaskHandler,
  createOpenMuseRuntime,
  detectClappTaskInput,
  type OpenMuseRuntime,
  type OpenMuseRuntimeDependencies,
} from "../packages/clapp-runtime-openmuse/src/index.ts";
import { config, ok, sandbox } from "./helpers/computer.ts";

/**
 * CLAPP-W1-003 — candidate workspace execution provider.
 *
 * Tests run a REAL in-process ComputerService against a scripted DockerRunner
 * (the tests/computer.test.ts precedent) extended with an in-memory sandbox
 * filesystem: file operations speak the substrate's stdin JSON files.py
 * protocol and composed bash commands (rm -rf, cat, sha256sum) are
 * interpreted against the same filesystem, so workspace lifecycle assertions
 * are real filesystem assertions driven by the substrate's own docker argv.
 * No Docker and no network are used anywhere.
 */
const owner = "owner";

let db: Store;
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-clapp-w1-003-"));
  db = await createStore({ dataDir: join(directory, "db") });
});

after(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** Seeds one durable task that carries a reconstruction (owner discovery). */
async function seedTask(reconstructionId: string, stage: string) {
  const task = {
    id: `task-${reconstructionId}`,
    status: "running",
    leaseId: null,
    input: { specVersion: "0.1", reconstructionId, stage },
    state: {} as Record<string, unknown>,
    updatedAt: new Date().toISOString(),
  };
  await db.put(owner, "tasks", task);
  return task;
}

const parentDirectory = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Tokenizer for the command shapes the candidate seam composes. Handles the
 * single-quoted strings shellQuote produces, including its '\'' escaping.
 */
function tokenize(command: string): string[] {
  const normalized = command.replaceAll("'\\''", "\u0000");
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let has = false;
  for (const character of normalized) {
    if (character === "'") {
      inQuote = !inQuote;
      has = true;
      continue;
    }
    if (!inQuote && character === " ") {
      if (has) {
        tokens.push(current);
        current = "";
        has = false;
      }
      continue;
    }
    current += character;
    has = true;
  }
  if (has) tokens.push(current);
  return tokens.map((token) => token.replaceAll("\u0000", "'"));
}

/** A scripted DockerRunner with an in-memory sandbox filesystem. */
function computerFixture(
  options: {
    onCommand?: (
      command: string,
      cwd: string,
      signal?: AbortSignal,
    ) => DockerResult | Promise<DockerResult | undefined> | undefined;
  } = {},
) {
  const identity = computerIdentity(config, owner);
  const inspection = sandbox(true, owner);
  const dirs = new Set<string>(["/workspace"]);
  const files = new Map<string, string>();
  const calls: { args: string[]; timeoutMs: number; input?: string }[] = [];
  const execs: { command: string; cwd: string }[] = [];
  const writes: { path: string; text: string }[] = [];
  const storedDocuments = new Map<string, Uint8Array>();
  const failure = (message: string): DockerResult => ({
    stdout: "",
    stderr: message,
    exitCode: 1,
    timedOut: false,
    interrupted: false,
    truncated: false,
  });
  const addDir = (path: string) => {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current += `/${part}`;
      dirs.add(current);
    }
  };
  const removeTree = (path: string) => {
    for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
    for (const file of [...files.keys()])
      if (file === path || file.startsWith(`${path}/`)) files.delete(file);
  };
  const entriesOf = (path: string) => {
    const entries = [
      ...[...dirs]
        .filter((dir) => dir !== "/workspace" && parentDirectory(dir) === path)
        .map((dir) => ({ name: baseName(dir), path: dir, type: "directory" as const, size: 0 })),
      ...[...files.keys()]
        .filter((file) => parentDirectory(file) === path)
        .map((file) => ({
          name: baseName(file),
          path: file,
          type: "file" as const,
          size: Buffer.byteLength(files.get(file) ?? ""),
        })),
    ];
    entries.sort(
      (a, b) =>
        Number(a.type !== "directory") - Number(b.type !== "directory") ||
        a.name.localeCompare(b.name),
    );
    return entries;
  };
  const interpret = (command: string): DockerResult => {
    const tokens = tokenize(command);
    if (tokens[0] === "rm" && tokens[1] === "-rf" && tokens.length === 3) {
      removeTree(tokens[2]);
      return ok();
    }
    if (tokens[0] === "cat") {
      const create = tokens.indexOf(">");
      const append = tokens.indexOf(">>");
      const index = create >= 0 ? create : append;
      if (index === -1 || index < 2 || tokens.length !== index + 2)
        return failure(`fake computer: unhandled cat shape: ${command}`);
      const parts = tokens.slice(1, index);
      const target = tokens[index + 1];
      if (parts.some((part) => !files.has(part)))
        return failure(`cat: a part of ${command} does not exist`);
      const content = parts.map((part) => files.get(part) ?? "").join("");
      const previous = append >= 0 ? (files.get(target) ?? "") : "";
      files.set(target, previous + content);
      return ok();
    }
    if (tokens[0] === "sha256sum" && tokens.length === 2) {
      const text = files.get(tokens[1]);
      if (text === undefined) return failure(`sha256sum: ${tokens[1]}: no such file`);
      return ok(`${createHash("sha256").update(text, "utf8").digest("hex")}  ${tokens[1]}\n`);
    }
    if (tokens[0] === "true") return ok();
    return failure(`fake computer: unhandled command: ${command}`);
  };
  const runner: DockerRunner = async (args, opts) => {
    calls.push({ args: [...args], timeoutMs: opts.timeoutMs, input: opts.input });
    if (args[0] === "container" && args[1] === "ls") return ok("container-id\n");
    if (args[0] === "container" && args[1] === "inspect") return ok(JSON.stringify([inspection]));
    if (args[0] === "volume" && args[1] === "ls") return ok(identity.volume);
    if (args[0] === "volume" && args[1] === "inspect")
      return ok(
        JSON.stringify([
          {
            Name: identity.volume,
            Labels: identity.labels,
            Driver: "local",
            Options: null,
            Scope: "local",
          },
        ]),
      );
    if (args[0] === "container" && args[1] === "stop") {
      inspection.State.Running = false;
      return ok();
    }
    if (args[0] === "container" && (args[1] === "start" || args[1] === "create")) return ok();
    if (args[0] === "exec" && args.includes("/opt/openmuse/files.py")) {
      const request = JSON.parse(opts.input ?? "{}") as {
        operation?: string;
        path?: string;
        text?: string;
      };
      const path = request.path ?? "";
      const missing = () => failure(`files.py: no such path: ${path}`);
      if (request.operation === "mkdir") {
        addDir(path);
        return ok(JSON.stringify({ path }));
      }
      if (request.operation === "write") {
        if (!dirs.has(parentDirectory(path))) return missing();
        files.set(path, request.text ?? "");
        writes.push({ path, text: request.text ?? "" });
        return ok(JSON.stringify({ path }));
      }
      if (request.operation === "read") {
        if (!files.has(path)) return missing();
        return ok(JSON.stringify({ path, text: files.get(path) }));
      }
      if (request.operation === "list") {
        if (!dirs.has(path)) return missing();
        return ok(JSON.stringify({ path, entries: entriesOf(path) }));
      }
      return failure(`files.py: unsupported operation ${request.operation}`);
    }
    if (args[0] === "exec") {
      const command = args.at(-1) ?? "";
      const cwd = args[4] ?? "/workspace";
      execs.push({ command, cwd });
      const scripted = await options.onCommand?.(command, cwd, opts.signal);
      if (scripted) return scripted;
      return interpret(command);
    }
    return ok();
  };
  /** A duck-typed files handle: the OpenMuse files service stores PDFs only. */
  const filesHandle = {
    async import(
      _owner: string,
      _name: string,
      bytes: Uint8Array,
      _source: string,
    ): Promise<{ id: string }> {
      if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-")
        throw new Error(
          "the files handle stores PDF documents only: bytes do not start with %PDF-",
        );
      const id = randomUUID();
      storedDocuments.set(id, bytes);
      return { id };
    },
    async bytes(_owner: string, id: string): Promise<Uint8Array> {
      const value = storedDocuments.get(id);
      if (!value) throw new Error(`no stored document ${id}`);
      return value;
    },
  };
  const service = () => new ComputerService(db, config, runner);
  const runtime = (candidate: boolean): OpenMuseRuntime =>
    createOpenMuseRuntime(
      {
        browserSession: undefined,
        computer: service(),
        files: filesHandle,
        agent: undefined,
        db,
      } satisfies OpenMuseRuntimeDependencies,
      candidate ? {} : undefined,
    );
  return { runner, calls, execs, writes, files, dirs, service, runtime, filesHandle };
}

test("execution returns result not exception on failure", async () => {
  await seedTask("recon-fail", "synthesize");
  const fixture = computerFixture({
    onCommand: async () => ({
      stdout: "partial output",
      stderr: "the build failed loudly",
      exitCode: 7,
      timedOut: false,
      interrupted: false,
      truncated: true,
    }),
  });
  const runtime = fixture.runtime(true);
  const result = await runtime.execution.run({
    reconstructionId: "recon-fail",
    cwd: "/workspace",
    command: "npm run build",
    timeoutMs: 5000,
    network: "deny",
  });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, "partial output");
  assert.equal(
    result.stderr,
    "the build failed loudly\nthe substrate truncated this command's captured output at its 128 KB limit; stdout and stderr above are partial",
  );
  assert.deepEqual(result.artifacts, []);
  assert.equal(typeof result.stdout, "string");
  assert.equal(typeof result.stderr, "string");
  assert.equal(fixture.execs.length, 1);
  // The durable substrate receipt exists and carries the same honest output.
  const receipts = await db.list(owner, "computer-commands");
  const receipt = receipts.find((row) => row.command === "npm run build");
  assert.ok(receipt);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.exitCode, 7);
  assert.equal(receipt.truncated, true);
});

test("network modes fail closed", async () => {
  await seedTask("recon-net", "synthesize");
  const fixture = computerFixture();
  const runtime = fixture.runtime(true);
  for (const network of ["allowlist", "full"] as const) {
    await assert.rejects(
      runtime.execution.run({
        reconstructionId: "recon-net",
        cwd: "/workspace",
        command: "true",
        timeoutMs: 5000,
        network,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ClappRuntimeError);
        assert.equal(error.provider, "execution");
        assert.equal(error.capability, "network");
        assert.match(error.message, new RegExp(network));
        return true;
      },
    );
  }
  assert.equal(fixture.execs.length, 0);
  const denied = await runtime.execution.run({
    reconstructionId: "recon-net",
    cwd: "/workspace",
    command: "true",
    timeoutMs: 5000,
    network: "deny",
  });
  assert.equal(denied.exitCode, 0);
  assert.equal(fixture.execs.length, 1);
});

test("timeout ceiling enforced before start", async () => {
  await seedTask("recon-ceiling", "synthesize");
  const fixture = computerFixture();
  const runtime = fixture.runtime(true);
  await assert.rejects(
    runtime.execution.run({
      reconstructionId: "recon-ceiling",
      cwd: "/workspace",
      command: "true",
      timeoutMs: 30_001,
      network: "deny",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClappRuntimeError);
      assert.equal(error.provider, "execution");
      assert.equal(error.capability, "timeoutMs");
      assert.match(error.message, /30.?000/);
      return true;
    },
  );
  // The typed error fires before any docker invocation is recorded.
  assert.equal(fixture.calls.length, 0);
});

test("idempotent runs return the same receipt", async () => {
  await seedTask("recon-idem", "synthesize");
  const fixture = computerFixture();
  const runtime = fixture.runtime(true);
  const input = {
    reconstructionId: "recon-idem",
    cwd: "/workspace",
    command: "true",
    timeoutMs: 5000,
    network: "deny" as const,
  };
  const first = await runtime.execution.run(input);
  assert.equal(first.exitCode, 0);
  assert.equal(fixture.execs.length, 1);
  const dockerCalls = fixture.calls.length;
  const second = await runtime.execution.run(input);
  assert.deepEqual(second, first);
  assert.equal(fixture.execs.length, 1);
  assert.equal(fixture.calls.length, dockerCalls, "the replayed run must not touch docker at all");
  // The durable receipt is registered under the substrate's idempotency-key id.
  const receiptId = createHash("sha256")
    .update(
      `computer-command:${createHash("sha256")
        .update(
          JSON.stringify({
            purpose: "clapp-execution",
            reconstructionId: input.reconstructionId,
            cwd: input.cwd,
            command: input.command,
            timeoutMs: input.timeoutMs,
            network: input.network,
          }),
        )
        .digest("hex")}`,
    )
    .digest("hex");
  const receipt = await db.get(owner, "computer-commands", receiptId);
  assert.ok(receipt, "the receipt must be durable under the derived idempotency key");
  assert.equal(receipt.status, "succeeded");
});

test("workspace create/destroy lifecycle", async () => {
  const task = await seedTask("recon-ws", "synthesize");
  const fixture = computerFixture();
  const runtime = fixture.runtime(true);
  const created = await runtime.workspaces.create({
    reconstructionId: "recon-ws",
    kind: "candidate",
  });
  assert.ok(created.path.startsWith("/workspace/clapp/"));
  assert.match(created.path, /candidate-1$/);
  assert.ok(fixture.dirs.has(created.path), "the workspace directory exists in the sandbox");
  // The id is registered in the run's stage state so recovery can find it.
  const saved = await db.get(owner, "tasks", task.id);
  assert.ok(saved);
  const registered = (
    (saved.state as Record<string, unknown>).clappWorkspaces as Record<string, unknown>
  ).candidate as { id: string; path: string; instance: number };
  assert.equal(registered.id, created.id);
  assert.equal(registered.path, created.path);
  assert.equal(registered.instance, 1);
  const record = await db.get(owner, "clapp-workspaces", "recon-ws:candidate");
  assert.ok(record);
  assert.equal(record.workspaceId, created.id);
  // Repeated creates while alive return the same stable id.
  const repeat = await runtime.workspaces.create({
    reconstructionId: "recon-ws",
    kind: "candidate",
  });
  assert.deepEqual(repeat, created);
  // Destroy removes the directory and the registry entry, and tombstones the id.
  await runtime.workspaces.destroy(created.id);
  assert.ok(!fixture.dirs.has(created.path), "the directory is gone after destroy");
  assert.equal(await db.get(owner, "clapp-workspaces", "recon-ws:candidate"), null);
  assert.ok(await db.get(owner, "clapp-workspace-tombstones", created.id));
  // Re-destroying an already-destroyed KNOWN id is an idempotent no-op.
  await runtime.workspaces.destroy(created.id);
  // Destroying an unknown id is a typed error.
  await assert.rejects(runtime.workspaces.destroy("never-existed-id"), (error: unknown) => {
    assert.ok(error instanceof ClappRuntimeError);
    assert.equal(error.provider, "workspaces");
    assert.match(error.message, /never-existed-id/);
    return true;
  });
  // The next create allocates a genuinely new id; the old one is never reused.
  const recreated = await runtime.workspaces.create({
    reconstructionId: "recon-ws",
    kind: "candidate",
  });
  assert.notEqual(recreated.id, created.id);
  assert.match(recreated.path, /candidate-2$/);
  assert.ok(fixture.dirs.has(recreated.path));
});

test("seed and chunked write stay under substrate limits", async () => {
  await seedTask("recon-seed", "synthesize");
  const fixture = computerFixture();
  const runtime = fixture.runtime(true);
  const seam = candidateSeamOf(runtime);
  const workspace = await runtime.workspaces.create({
    reconstructionId: "recon-seed",
    kind: "candidate",
  });
  // A small file is a single bounded write.
  const small = await seam.workspaces.seedWorkspaceFile({
    reconstructionId: "recon-seed",
    workspaceId: workspace.id,
    path: "package.json",
    content: '{"name":"candidate"}',
  });
  assert.equal(small.chunks, 1);
  assert.equal(small.bytes, Buffer.byteLength('{"name":"candidate"}'));
  assert.equal(fixture.files.get(`${workspace.path}/package.json`), '{"name":"candidate"}');
  // Paths with quotes and spaces survive the composed command quoting.
  await seam.workspaces.seedWorkspaceFile({
    reconstructionId: "recon-seed",
    workspaceId: workspace.id,
    path: "tricky'name and space.txt",
    content: "kept verbatim",
  });
  assert.equal(fixture.files.get(`${workspace.path}/tricky'name and space.txt`), "kept verbatim");
  // A large multibyte file is chunked under the 256 KB limit and reassembled byte-identically.
  const content = "αβγδε".repeat(100_000);
  const big = await seam.workspaces.seedWorkspaceFile({
    reconstructionId: "recon-seed",
    workspaceId: workspace.id,
    path: "src/generated.ts",
    content,
  });
  assert.equal(big.bytes, 1_000_000);
  assert.ok(big.chunks > 1, "the content must be split into multiple chunks");
  assert.ok(
    fixture.writes.every((write) => Buffer.byteLength(write.text) <= 256 * 1024),
    "every single write stays under the substrate's 256 KB limit",
  );
  assert.equal(fixture.files.get(`${workspace.path}/src/generated.ts`), content);
  assert.ok(
    !Array.from(fixture.files.keys()).some((file) =>
      file.startsWith("/workspace/clapp/.clapp-parts"),
    ),
    "no temporary part files remain",
  );
  assert.ok(
    !Array.from(fixture.dirs).some(
      (dir) =>
        dir === `${workspace.path}/.clapp-parts` ||
        dir.startsWith(`${workspace.path}/.clapp-parts/`),
    ),
    "the workspace tree is never polluted with reassembly parts",
  );
  assert.ok(fixture.execs.some((exec) => exec.command.startsWith("cat ")));
  assert.ok(fixture.execs.some((exec) => exec.command.startsWith("sha256sum ")));
  assert.ok(
    fixture.execs.every((exec) => exec.command.length <= 16_000),
    "composed commands stay under the substrate's 16 000-character limit",
  );
  // Escape attempts fail closed with typed errors.
  for (const path of ["../escape.txt", "/absolute.txt", "a/../b.txt"]) {
    await assert.rejects(
      seam.workspaces.seedWorkspaceFile({
        reconstructionId: "recon-seed",
        workspaceId: workspace.id,
        path,
        content: "x",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ClappRuntimeError);
        assert.equal(error.provider, "candidate");
        return true;
      },
    );
  }
  // The bounded listing sees the seeded tree with workspace-relative paths.
  const listed = await seam.workspaces.listWorkspaceFiles({
    reconstructionId: "recon-seed",
    workspaceId: workspace.id,
  });
  assert.deepEqual(
    listed.map((entry) => `${entry.type}:${entry.path}`),
    [
      "file:package.json",
      "directory:src",
      "file:src/generated.ts",
      "file:tricky'name and space.txt",
    ],
  );
});

test("abort surfaces interrupted state honestly", async () => {
  await seedTask("recon-abort", "synthesize");
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const fixture = computerFixture({
    onCommand: (_command, _cwd, signal) =>
      new Promise<DockerResult>((resolve) => {
        signalStarted?.();
        const finish = () =>
          resolve({
            stdout: "partial",
            stderr: "",
            exitCode: null,
            timedOut: false,
            interrupted: true,
            truncated: false,
          });
        if (signal?.aborted) {
          finish();
          return;
        }
        signal?.addEventListener("abort", finish, { once: true });
      }),
  });
  const runtime = fixture.runtime(true);
  const input = {
    reconstructionId: "recon-abort",
    cwd: "/workspace",
    command: "npm run build",
    timeoutMs: 5000,
    network: "deny" as const,
  };
  const controller = new AbortController();
  const running = runtime.execution.run(input, controller.signal);
  await started;
  controller.abort();
  const result = await running;
  assert.equal(result.exitCode, 137, "an aborted run surfaces the interruption convention");
  assert.notEqual(result.exitCode, 0, "an aborted run is never a success");
  assert.equal(result.stdout, "partial");
  assert.equal(fixture.execs.length, 1);
  // Recovery: a follow-up run with the same input replays the recorded
  // interrupted receipt instead of re-executing.
  const replay = await runtime.execution.run(input);
  assert.deepEqual(replay, result);
  assert.equal(fixture.execs.length, 1);
});

test("wave 1 surface unchanged", async () => {
  await seedTask("recon-wave1", "synthesize");
  // Compile-time surface: every Wave 1 export still exists with its call shape.
  const stages: readonly ClappStage[] = CLAPP_STAGES;
  assert.equal(stages.length, 10);
  const detection = detectClappTaskInput({
    specVersion: "0.1",
    reconstructionId: "recon-wave1",
    stage: "explore",
  });
  assert.equal(detection.type, "clapp");
  const handler = createClappTaskHandler({
    executor: {
      execute: async () => ({ outputArtifactIds: [] }),
    },
    fallback: async () => ({ status: "succeeded" as const }),
  });
  assert.equal(typeof handler, "function");
  assert.ok(new ClappHandleNotProvidedError("execution", "computer") instanceof ClappRuntimeError);
  assert.ok(new ClappRuntimeError("provider", "capability", "message") instanceof Error);

  // The new options object is OPTIONAL: the adapter constructs without it.
  const fixture = computerFixture();
  const runtime = createOpenMuseRuntime({
    browserSession: undefined,
    computer: fixture.service(),
    files: fixture.filesHandle,
    agent: undefined,
    db,
  });
  // Wave 1 first-cut execution still works and re-executes repeated runs.
  const input = {
    reconstructionId: "recon-wave1",
    cwd: "/workspace",
    command: "true",
    timeoutMs: 5000,
    network: "deny" as const,
  };
  const first = await runtime.execution.run(input);
  const second = await runtime.execution.run(input);
  assert.deepEqual(second, first);
  assert.equal(fixture.execs.length, 2, "the Wave 1 first-cut bridge re-executes each run");
  // Wave 1 first-cut workspaces still use their uuid path scheme.
  const workspace = await runtime.workspaces.create({
    reconstructionId: "recon-wave1",
    kind: "candidate",
  });
  assert.match(workspace.path, /^\/workspace\/clapp\/candidate-[0-9a-f-]{36}$/);
  // The seam methods fail closed with typed not-configured errors ONLY when used.
  const seam = candidateSeamOf(runtime);
  await assert.rejects(
    seam.workspaces.seedWorkspaceFile({
      reconstructionId: "recon-wave1",
      workspaceId: workspace.id,
      path: "x.txt",
      content: "x",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClappNotConfiguredError);
      assert.ok(error instanceof ClappRuntimeError);
      return true;
    },
  );
  await assert.rejects(
    seam.workspaces.listWorkspaceFiles({
      reconstructionId: "recon-wave1",
      workspaceId: workspace.id,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClappNotConfiguredError);
      return true;
    },
  );
  await assert.rejects(
    seam.workspaces.discoverWorkspaces({ reconstructionId: "recon-wave1" }),
    (error: unknown) => {
      assert.ok(error instanceof ClappNotConfiguredError);
      return true;
    },
  );
  await assert.rejects(
    seam.execution.runCandidateBuild({
      reconstructionId: "recon-wave1",
      cwd: "/workspace",
      build: "true",
      timeoutMs: 5000,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClappNotConfiguredError);
      return true;
    },
  );
  await assert.rejects(
    seam.execution.harvestWorkspaceArtifacts({
      reconstructionId: "recon-wave1",
      workspaceId: workspace.id,
      paths: ["x.txt"],
      targetId: "target-wave1",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ClappNotConfiguredError);
      return true;
    },
  );
  // Without options AND without a computer handle, the Wave 1 call-time
  // fail-closed behavior is preserved.
  const bare = createOpenMuseRuntime({
    browserSession: undefined,
    computer: undefined,
    files: undefined,
    agent: undefined,
    db,
  });
  await assert.rejects(bare.execution.run(input), ClappHandleNotProvidedError);
  await assert.rejects(
    bare.workspaces.create({ reconstructionId: "recon-wave1", kind: "candidate" }),
    ClappHandleNotProvidedError,
  );
  // Bind-time validation with options and an incomplete computer handle fails
  // closed with a typed error naming the provider and the missing capability.
  assert.throws(
    () =>
      createOpenMuseRuntime(
        {
          browserSession: undefined,
          computer: { execute: async () => ({}), mkdir: async () => ({}) },
          files: undefined,
          agent: undefined,
          db,
        },
        {},
      ),
    (error: unknown) => {
      assert.ok(error instanceof ClappRuntimeError);
      assert.equal(error.provider, "computer");
      assert.equal(error.capability, "read");
      assert.match(error.message, /candidate execution and workspaces/);
      return true;
    },
  );
});

test("workspace discovery after restart", async () => {
  await seedTask("recon-restart", "synthesize");
  const fixture = computerFixture();
  const first = fixture.runtime(true);
  const created = await first.workspaces.create({
    reconstructionId: "recon-restart",
    kind: "candidate",
  });
  // Destroy all in-memory state: a fresh ComputerService and a fresh runtime
  // share only the durable db and the sandbox filesystem.
  const second = fixture.runtime(true);
  const discovered = await candidateSeamOf(second).workspaces.discoverWorkspaces({
    reconstructionId: "recon-restart",
  });
  assert.equal(discovered.length, 1);
  assert.deepEqual(discovered[0], {
    id: created.id,
    path: created.path,
    kind: "candidate",
    instance: 1,
    registered: true,
    tombstoned: false,
  });
  // The path scheme alone locates the directory even without the registry
  // record (the crash window between mkdir and the registry write).
  await db.remove(owner, "clapp-workspaces", "recon-restart:candidate");
  const third = fixture.runtime(true);
  const orphan = await candidateSeamOf(third).workspaces.discoverWorkspaces({
    reconstructionId: "recon-restart",
  });
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].path, created.path);
  assert.equal(orphan[0].id, created.id);
  assert.equal(orphan[0].registered, false);
  // A reconstruction with no workspaces discovers none.
  await seedTask("recon-empty", "synthesize");
  const empty = await candidateSeamOf(third).workspaces.discoverWorkspaces({
    reconstructionId: "recon-empty",
  });
  assert.deepEqual(empty, []);
});

test("candidate build composes steps and harvests artifacts honestly", async () => {
  await seedTask("recon-build", "synthesize");
  const fixture = computerFixture({
    onCommand: async (command) =>
      command === "npm run build" || command === "npm test" ? ok() : undefined,
  });
  const runtime = fixture.runtime(true);
  const seam = candidateSeamOf(runtime);
  const workspace = await runtime.workspaces.create({
    reconstructionId: "recon-build",
    kind: "candidate",
  });
  await seam.workspaces.seedWorkspaceFile({
    reconstructionId: "recon-build",
    workspaceId: workspace.id,
    path: "dist/report.pdf",
    content: "%PDF-1.4 candidate build output",
  });
  await seam.workspaces.seedWorkspaceFile({
    reconstructionId: "recon-build",
    workspaceId: workspace.id,
    path: "dist/bundle.js",
    content: "console.log('candidate')",
  });
  const outcome = await seam.execution.runCandidateBuild({
    reconstructionId: "recon-build",
    cwd: workspace.path,
    build: "npm run build",
    test: "npm test",
    timeoutMs: 5000,
    network: "deny",
    harvest: {
      workspaceId: workspace.id,
      paths: ["dist/report.pdf", "dist/bundle.js"],
      targetId: "target-build",
    },
  });
  assert.equal(outcome.succeeded, true);
  assert.equal(outcome.steps.length, 2);
  assert.equal(outcome.steps[0].name, "build");
  assert.equal(outcome.steps[0].exitCode, 0);
  assert.equal(outcome.steps[0].command, "npm run build");
  assert.equal(outcome.steps[1].name, "test");
  assert.equal(outcome.steps[1].exitCode, 0);
  assert.equal(outcome.exitCode, 0);
  // The PDF harvest becomes a content-addressed artifact id; the text bundle
  // honestly fails because the v0.1 files service stores PDF documents only.
  assert.equal(outcome.artifacts.length, 1);
  assert.match(outcome.artifacts[0], /^[0-9a-f]{64}$/);
  assert.equal(outcome.harvestFailures.length, 1);
  assert.equal(outcome.harvestFailures[0].path, "dist/bundle.js");
  assert.match(outcome.harvestFailures[0].reason, /PDF/);
  const artifact = await db.get(owner, "clapp-artifacts", outcome.artifacts[0]);
  assert.ok(artifact);
  assert.equal(artifact.targetId, "target-build");
  assert.equal(artifact.reconstructionId, "recon-build");
  assert.equal(artifact.classification, "derived");

  // A failing build records its step result and honestly skips the test step.
  await seedTask("recon-build-fail", "synthesize");
  const failing = computerFixture({
    onCommand: async (command) =>
      command.includes("npm run build")
        ? {
            stdout: "",
            stderr: "the build broke",
            exitCode: 1,
            timedOut: false,
            interrupted: false,
            truncated: false,
          }
        : ok(),
  });
  const failingRuntime = failing.runtime(true);
  const failedWorkspace = await failingRuntime.workspaces.create({
    reconstructionId: "recon-build-fail",
    kind: "candidate",
  });
  const failure = await candidateSeamOf(failingRuntime).execution.runCandidateBuild({
    reconstructionId: "recon-build-fail",
    cwd: failedWorkspace.path,
    build: "npm run build",
    test: "npm test",
    timeoutMs: 5000,
    network: "deny",
    harvest: {
      workspaceId: failedWorkspace.id,
      paths: ["dist/report.pdf"],
      targetId: "target-build-fail",
    },
  });
  assert.equal(failure.succeeded, false);
  assert.equal(failure.exitCode, 1);
  assert.equal(failure.steps.length, 1);
  assert.equal(failure.steps[0].name, "build");
  assert.equal(failure.steps[0].stderr, "the build broke");
  assert.deepEqual(failure.artifacts, []);
  assert.deepEqual(failure.harvestFailures, []);
});
