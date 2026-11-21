export const PROPRIO_EVAL_KERNEL_COMPATIBILITY = Object.freeze({
  schema: "proprio.eval-kernel.compatibility.v1" as const,
  packageName: "@groktopus/proprio-eval-kernel" as const,
  packageVersion: "0.1.0" as const,
  apiVersion: 1 as const,
});

export interface ProprioEvalScenario<TInput = unknown> {
  readonly id: string;
  readonly input: TInput;
}

export interface ProprioEvalCandidate<TCandidate = unknown> {
  readonly id: string;
  readonly config: TCandidate;
  /** Fail-closed runner/catalog/provider compatibility check. */
  readonly preflight?: () => void | Promise<void>;
}

export interface ProprioEvalResult<TOutput = unknown, TScore = unknown> {
  readonly scenarioId: string;
  readonly candidateId: string;
  readonly output: TOutput;
  readonly score: TScore;
}

export class ProprioEvalKernelConfigurationError extends Error {
  readonly code = "proprio_eval_kernel_configuration_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProprioEvalKernelConfigurationError";
  }
}

/**
 * Generic deterministic matrix orchestration. Scenario definitions, provider
 * configuration, scorers, reports, and persistence remain caller-owned.
 */
export async function runProprioEvalMatrix<
  TInput,
  TCandidate,
  TOutput,
  TScore,
>(input: {
  readonly scenarios: readonly ProprioEvalScenario<TInput>[];
  readonly candidates: readonly ProprioEvalCandidate<TCandidate>[];
  readonly execute: (context: {
    readonly scenario: ProprioEvalScenario<TInput>;
    readonly candidate: ProprioEvalCandidate<TCandidate>;
  }) => Promise<TOutput>;
  readonly score: (context: {
    readonly scenario: ProprioEvalScenario<TInput>;
    readonly candidate: ProprioEvalCandidate<TCandidate>;
    readonly output: TOutput;
  }) => Promise<TScore> | TScore;
}): Promise<readonly ProprioEvalResult<TOutput, TScore>[]> {
  assertUniqueNonEmptyIds("scenario", input.scenarios);
  assertUniqueNonEmptyIds("candidate", input.candidates);

  for (const candidate of input.candidates) {
    await candidate.preflight?.();
  }

  const results: ProprioEvalResult<TOutput, TScore>[] = [];
  for (const scenario of input.scenarios) {
    for (const candidate of input.candidates) {
      const output = await input.execute({ scenario, candidate });
      const score = await input.score({ scenario, candidate, output });
      results.push(Object.freeze({
        scenarioId: scenario.id,
        candidateId: candidate.id,
        output,
        score,
      }));
    }
  }
  return Object.freeze(results);
}

function assertUniqueNonEmptyIds(
  kind: "scenario" | "candidate",
  values: readonly { readonly id: string }[],
): void {
  if (values.length === 0) {
    throw new ProprioEvalKernelConfigurationError(`${kind} list must not be empty`);
  }
  const ids = new Set<string>();
  for (const value of values) {
    if (value.id.trim().length === 0) {
      throw new ProprioEvalKernelConfigurationError(`${kind} id must not be empty`);
    }
    if (ids.has(value.id)) {
      throw new ProprioEvalKernelConfigurationError(`duplicate ${kind} id: ${value.id}`);
    }
    ids.add(value.id);
  }
}
