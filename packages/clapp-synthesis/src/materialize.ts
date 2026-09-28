import { validateGeneratedApp } from "./app-validate.ts";
import type { GeneratedApp } from "./generator.ts";

/** The honest network modes a candidate build can declare; default is "deny". */
export type CandidateNetworkMode = "deny" | "allowlist" | "full";

/** The W1-003 seam's seeding result shape. */
export type CandidateSeedResultShape = { path: string; bytes: number; chunks: number };

/** The W1-003 seam's build step result shape. */
export type CandidateBuildStepShape = {
  name: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts: string[];
};

/** The W1-003 seam's composed build outcome shape. */
export type CandidateBuildOutcomeShape = {
  steps: CandidateBuildStepShape[];
  exitCode: number;
  succeeded: boolean;
  artifacts: string[];
  harvestFailures: { path: string; reason: string }[];
};

/**
 * Narrow structural view of the W1-003 candidate workspace execution seam.
 *
 * This package never imports the runtime adapter (framework-neutral
 * layering, ADR-002). The interface matches the method shapes of the W1-003
 * seam so the real surface composes by direct structural assignment — for
 * example, from the OpenMuse adapter:
 *
 * ```ts
 * const seam: CandidateSeam = candidateSeamOf(
 *   createOpenMuseRuntime(deps, candidateOptions),
 * );
 * ```
 *
 * `workspaces.create` is the frozen WorkspaceProvider contract;
 * `workspaces.seedWorkspaceFile` and `execution.runCandidateBuild` are the
 * W1-003 candidate seam methods. A fake seam implementing exactly these
 * three methods is a valid CandidateSeam, which is how the composition is
 * tested without a real computer.
 */
export interface CandidateSeam {
  workspaces: {
    create(input: {
      reconstructionId: string;
      kind: "reference" | "candidate";
    }): Promise<{ id: string; path: string }>;
    seedWorkspaceFile(input: {
      reconstructionId: string;
      workspaceId: string;
      path: string;
      content: string;
    }): Promise<CandidateSeedResultShape>;
  };
  execution: {
    runCandidateBuild(
      input: {
        reconstructionId: string;
        cwd: string;
        build: string;
        test?: string;
        timeoutMs: number;
        network?: CandidateNetworkMode;
      },
      signal?: AbortSignal,
    ): Promise<CandidateBuildOutcomeShape>;
  };
}

/** Default bounded timeout for the composed candidate build (substrate ceiling: 30s). */
export const DEFAULT_CANDIDATE_TIMEOUT_MS = 30_000;

/** What materializeCandidate needs: the owning reconstruction plus build bounds. */
export type MaterializeCandidateInput = {
  reconstructionId: string;
  timeoutMs?: number;
  network?: CandidateNetworkMode;
};

/** A materialized (but not yet built) candidate workspace. */
export type Materialization = {
  reconstructionId: string;
  workspaceId: string;
  workspacePath: string;
  buildCommand: string;
  testCommand: string;
  timeoutMs: number;
  network: CandidateNetworkMode;
};

/**
 * Materializes a generated application through the candidate seam: creates a
 * "candidate" workspace and seeds every file in path order, then returns the
 * materialization WITHOUT running the build (running is what
 * runGeneratedCandidateBuild composes from the manifest's commands).
 *
 * Refuses invalid applications before any seam call (fail closed, no partial
 * workspaces from garbage input).
 */
export async function materializeCandidate(
  app: GeneratedApp,
  seam: CandidateSeam,
  input: MaterializeCandidateInput,
): Promise<Materialization> {
  const validation = validateGeneratedApp(app);
  if (!validation.ok) {
    throw new TypeError(
      `refusing to materialize an invalid generated app: ${validation.errors.join("; ")}`,
    );
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`timeoutMs must be a positive integer; received ${String(timeoutMs)}`);
  }
  const network = input.network ?? "deny";

  const workspace = await seam.workspaces.create({
    reconstructionId: input.reconstructionId,
    kind: "candidate",
  });
  for (const file of app.files) {
    await seam.workspaces.seedWorkspaceFile({
      reconstructionId: input.reconstructionId,
      workspaceId: workspace.id,
      path: file.path,
      content: file.content,
    });
  }
  return {
    reconstructionId: input.reconstructionId,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    buildCommand: app.manifest.buildCommand,
    testCommand: app.manifest.testCommand,
    timeoutMs,
    network,
  };
}

/**
 * Runs the materialized candidate's build (and test) by composing the seam's
 * runCandidateBuild with the manifest's commands at the workspace path.
 */
export function runGeneratedCandidateBuild(
  seam: CandidateSeam,
  materialization: Materialization,
  signal?: AbortSignal,
): Promise<CandidateBuildOutcomeShape> {
  return seam.execution.runCandidateBuild(
    {
      reconstructionId: materialization.reconstructionId,
      cwd: materialization.workspacePath,
      build: materialization.buildCommand,
      test: materialization.testCommand,
      timeoutMs: materialization.timeoutMs,
      network: materialization.network,
    },
    signal,
  );
}
