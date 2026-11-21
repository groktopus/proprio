import { describe, expect, it } from "vitest";
import {
  getCloudStackContext,
  isCloudManagedInstance,
  isCloudStagingInstance,
  type CloudInstanceEnv,
} from "../services/cloud-instance.js";

describe("isCloudManagedInstance", () => {
  it("unifies both prior signals without weakening either restrictive floor", () => {
    const cases: CloudInstanceEnv[] = [
      {},
      { PROPRIO_CLOUD_TENANT_SERVER_TOKEN: "tenant-token" },
      { PROPRIO_MANAGED_CONFIG: "" },
      {
        PROPRIO_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
        PROPRIO_MANAGED_CONFIG: "managed-document",
      },
    ];

    for (const env of cases) {
      const priorTokenFloor = Boolean(env.PROPRIO_CLOUD_TENANT_SERVER_TOKEN?.trim());
      const priorManagedConfigFloor = env.PROPRIO_MANAGED_CONFIG !== undefined;
      const canonicalFloor = isCloudManagedInstance(env);

      expect(canonicalFloor).toBe(priorTokenFloor || priorManagedConfigFloor);
      expect(canonicalFloor || !priorTokenFloor).toBe(true);
      expect(canonicalFloor || !priorManagedConfigFloor).toBe(true);
    }
  });

  it("does not treat a blank tenant token alone as a managed signal", () => {
    expect(isCloudManagedInstance({ PROPRIO_CLOUD_TENANT_SERVER_TOKEN: "   " })).toBe(false);
  });
});

describe("isCloudStagingInstance", () => {
  it("requires both a managed instance and a provisioner-owned staging hostname", () => {
    expect(isCloudStagingInstance({
      PROPRIO_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
      PROPRIO_PRIMARY_HOST: " team.staging.paperclip.app ",
    })).toBe(true);
    expect(isCloudStagingInstance({
      PROPRIO_MANAGED_CONFIG: "managed-document",
      PROPRIO_PRIMARY_HOST: "team.staging.paperclip.app",
    })).toBe(true);
    expect(isCloudStagingInstance({ PROPRIO_PRIMARY_HOST: "team.staging.paperclip.app" })).toBe(false);
  });

  it.each([undefined, "", "team.paperclip.app", "localhost", "staging.example.com", "team.staging.proprio.app.evil.com"])(
    "keeps production restrictions with primary host %s",
    (primaryHost) => {
      expect(isCloudStagingInstance({
        PROPRIO_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
        PROPRIO_PRIMARY_HOST: primaryHost,
        NODE_ENV: "development",
      })).toBe(false);
    },
  );
});

describe("getCloudStackContext", () => {
  it("returns null outside Proprio Cloud even when stray stack metadata exists", () => {
    expect(getCloudStackContext({ PROPRIO_STACK_SLUG: "stray-stack" })).toBeNull();
  });

  it("returns normalized provisioner metadata for cloud instances", () => {
    expect(getCloudStackContext({
      PROPRIO_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
      PROPRIO_CLOUD_STACK_ID: " stack-1 ",
      PROPRIO_STACK_SLUG: " acme ",
      PROPRIO_CLOUD_ACCOUNT_GROUP_ID: " account-group-1 ",
      PROPRIO_PRIMARY_HOST: " acme.paperclip.app ",
      PROPRIO_CLOUD_API_ORIGIN: " https://app.paperclip.app ",
    })).toEqual({
      stackId: "stack-1",
      stackSlug: "acme",
      accountGroupId: "account-group-1",
      primaryHost: "acme.paperclip.app",
      cloudOrigin: "https://app.paperclip.app",
    });
  });

  it("represents missing managed metadata explicitly without failing health checks", () => {
    expect(getCloudStackContext({ PROPRIO_MANAGED_CONFIG: "managed-document" })).toEqual({
      stackId: null,
      stackSlug: null,
      accountGroupId: null,
      primaryHost: null,
      cloudOrigin: null,
    });
  });
});
