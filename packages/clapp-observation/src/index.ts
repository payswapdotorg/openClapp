import type { EvidenceBundle, ObservationProvider, ReconstructionSpec } from "@clapp/contracts";

export interface ObservationEngine {
  capture(
    spec: ReconstructionSpec,
    provider: ObservationProvider,
    signal?: AbortSignal,
  ): Promise<EvidenceBundle>;
}

export function createObservationEngine(): ObservationEngine {
  return {
    capture(spec, provider, signal) {
      return provider.observe(spec, signal);
    },
  };
}
