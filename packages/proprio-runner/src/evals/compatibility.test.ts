import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PROPRIO_RUNNER_BUILD_METADATA,
  PROPRIO_RUNNERD_BUILD_METADATA_SCHEMA,
} from "./build-metadata.js";
import {
  ProprioRunnerEvalCompatibilityError,
  assertProprioRunnerEvalCompatibility,
  type ProprioRunnerEvalCompatibilityRequirement,
} from "./compatibility.js";

function compatible(): ProprioRunnerEvalCompatibilityRequirement {
  return {
    consumer: "proprio-evals",
    packageVersion: PROPRIO_RUNNER_BUILD_METADATA.package.version,
    runnerd: {
      schema: PROPRIO_RUNNERD_BUILD_METADATA_SCHEMA,
      binaryName: "proprio-runnerd",
      packageName: "@groktopus/proprio-runner",
      packageVersion: PROPRIO_RUNNER_BUILD_METADATA.package.version,
      binaryContractVersion: PROPRIO_RUNNER_BUILD_METADATA.contracts.runnerdArtifact,
      nativeExecutionVersion: 1,
      harnessDriverVersion: 1,
      prp: { name: "proprio.runner", minimumVersion: 1, maximumVersion: 1 },
    },
    nativeExecutionVersion: 1,
    prp: { minimumVersion: 1, maximumVersion: 1 },
    catalog: {
      version: PROPRIO_RUNNER_BUILD_METADATA.semanticCatalog.version,
      sha256: PROPRIO_RUNNER_BUILD_METADATA.semanticCatalog.sha256,
    },
    driver: {
      contractVersion: 1,
      requiredCapabilities: ["typedEvents", "interruption", "usage", "dynamicTools"],
      descriptor: {
        kind: "proprio-deterministic",
        displayName: "Deterministic",
        version: "1.0.0",
        protocolVersion: "prp.v1",
        capabilities: {
          resume: true,
          typedEvents: true,
          steering: false,
          interruption: true,
          structuredResult: true,
          usage: true,
          dynamicTools: true,
        },
      },
    },
  };
}

describe("Proprio Evals integration compatibility", () => {
  it("keeps build metadata synchronized with package semver", () => {
    const packageJson = JSON.parse(readFileSync(
      fileURLToPath(new URL("../../package.json", import.meta.url)),
      "utf8",
    ));
    expect(PROPRIO_RUNNER_BUILD_METADATA.package.version).toBe(packageJson.version);
  });

  it("negotiates package, binary, PRP, catalog, and driver V1", () => {
    expect(assertProprioRunnerEvalCompatibility(compatible())).toMatchObject({
      schema: "proprio-runner/evals-integration/v1",
      consumer: "proprio-evals",
      negotiatedPrpVersion: 1,
      driverKind: "proprio-deterministic",
    });
  });

  it("fails closed with actionable codes for every independently versioned input", () => {
    const requirement = compatible();
    requirement.packageVersion = "9.0.0";
    requirement.runnerd.packageVersion = "8.0.0";
    requirement.runnerd.binaryContractVersion = 3;
    requirement.runnerd.nativeExecutionVersion = 2;
    requirement.runnerd.harnessDriverVersion = 2;
    requirement.nativeExecutionVersion = 2;
    const unsupportedVersion = PROPRIO_RUNNER_BUILD_METADATA.prp.maximumVersion + 1;
    requirement.prp = { minimumVersion: unsupportedVersion, maximumVersion: unsupportedVersion };
    requirement.runnerd.prp = { name: "proprio.runner", minimumVersion: unsupportedVersion, maximumVersion: unsupportedVersion };
    requirement.catalog = { version: 2, sha256: `sha256:${"0".repeat(64)}` };
    requirement.driver.contractVersion = 2;
    requirement.driver.descriptor.capabilities.dynamicTools = false;

    try {
      assertProprioRunnerEvalCompatibility(requirement);
      throw new Error("expected compatibility failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProprioRunnerEvalCompatibilityError);
      expect((error as ProprioRunnerEvalCompatibilityError).issues.map((item) => item.code))
        .toEqual([
          "package_version_mismatch",
          "binary_package_version_mismatch",
          "binary_contract_version_mismatch",
          "native_execution_version_mismatch",
          "prp_version_no_overlap",
          "catalog_version_mismatch",
          "catalog_digest_mismatch",
          "driver_contract_version_mismatch",
          "driver_capability_unsupported",
        ]);
      expect((error as Error).message).toContain("runnerd was built for package 8.0.0");
    }
  });

  it("rejects a driver that does not speak the negotiated PRP version", () => {
    const requirement = compatible();
    requirement.driver.descriptor.protocolVersion = "prp.v2";

    expect(() => assertProprioRunnerEvalCompatibility(requirement)).toThrow(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "driver_protocol_version_mismatch" })],
      }),
    );
  });
});
