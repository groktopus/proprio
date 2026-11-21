import { createHash } from "node:crypto";

import { PROPRIO_RUNNER_COMPATIBILITY } from "../compatibility.js";
import {
  PRP_PROTOCOL_MIN_VERSION,
  PRP_PROTOCOL_NAME,
  PRP_PROTOCOL_VERSION,
} from "../protocol/replay-contract.js";
import { canonicalCapabilitySemanticCatalog } from "../semantic-tools/catalog.js";

export const PROPRIO_RUNNER_BUILD_METADATA_SCHEMA =
  "proprio-runner/build-metadata/v1" as const;
export const PROPRIO_RUNNER_NATIVE_EXECUTION_SCHEMA =
  "proprio-runner/native-execution/v1" as const;
export const PROPRIO_RUNNER_EVAL_INTEGRATION_SCHEMA =
  "proprio-runner/evals-integration/v1" as const;
export const PROPRIO_RUNNERD_BUILD_METADATA_SCHEMA =
  "proprio-runner/runnerd-build-metadata/v1" as const;

export const PROPRIO_RUNNER_SEMANTIC_CATALOG_SHA256 =
  `sha256:${createHash("sha256")
    .update(canonicalCapabilitySemanticCatalog())
    .digest("hex")}` as const;

/**
 * App-owned release metadata that Evals pins beside every native attempt.
 * Contract versions are independent from package semver so consumers can give
 * a precise mismatch instead of guessing from a package version.
 */
export const PROPRIO_RUNNER_BUILD_METADATA = Object.freeze({
  schema: PROPRIO_RUNNER_BUILD_METADATA_SCHEMA,
  package: Object.freeze({
    name: PROPRIO_RUNNER_COMPATIBILITY.packageName,
    version: PROPRIO_RUNNER_COMPATIBILITY.packageVersion,
  }),
  contracts: Object.freeze({
    evalIntegration: PROPRIO_RUNNER_COMPATIBILITY.components.evalIntegration,
    nativeExecution: PROPRIO_RUNNER_COMPATIBILITY.components.nativeExecution,
    runnerdArtifact: PROPRIO_RUNNER_COMPATIBILITY.components.runnerdBinary,
    prp: PRP_PROTOCOL_VERSION,
    semanticCatalog: PROPRIO_RUNNER_COMPATIBILITY.components.catalog,
    harnessDriver: PROPRIO_RUNNER_COMPATIBILITY.components.harnessDriver,
    controlPlaneAdapter: PROPRIO_RUNNER_COMPATIBILITY.components.controlPlaneAdapter,
    testkit: PROPRIO_RUNNER_COMPATIBILITY.components.testkit,
  }),
  prp: Object.freeze({
    name: PRP_PROTOCOL_NAME,
    minimumVersion: PRP_PROTOCOL_MIN_VERSION,
    maximumVersion: PRP_PROTOCOL_VERSION,
  }),
  semanticCatalog: Object.freeze({
    version: PROPRIO_RUNNER_COMPATIBILITY.components.catalog,
    sha256: PROPRIO_RUNNER_SEMANTIC_CATALOG_SHA256,
  }),
  runnerd: Object.freeze({
    binaryName: "proprio-runnerd" as const,
    metadataSchema: PROPRIO_RUNNERD_BUILD_METADATA_SCHEMA,
    digestAlgorithm: "sha256" as const,
  }),
});

export type ProprioRunnerBuildMetadata = typeof PROPRIO_RUNNER_BUILD_METADATA;
