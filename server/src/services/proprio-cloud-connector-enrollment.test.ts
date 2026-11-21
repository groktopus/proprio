import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeProprioCloudConnectorEnrollment,
  loadProprioCloudConnectorIdentity,
  proprioCloudConnectorEnrollmentStatus,
  proprioCloudConnectorIdentityPath,
  startProprioCloudConnectorEnrollment,
} from "./proprio-cloud-connector-enrollment.js";
import { proprioCloudConnectorConfigFromEnv } from "./proprio-cloud-connector.js";
import { reconcileProprioCloudConnectorEnrollmentStatus } from "./proprio-cloud-connector-status.js";

describe("Proprio Cloud self-host enrollment", () => {
  let root = "";
  let previousHome: string | undefined;
  let previousInstance: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "proprio-cloud-connector-"));
    previousHome = process.env.PROPRIO_HOME;
    previousInstance = process.env.PROPRIO_INSTANCE_ID;
    process.env.PROPRIO_HOME = root;
    process.env.PROPRIO_INSTANCE_ID = "connector-test";
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.PROPRIO_HOME;
    else process.env.PROPRIO_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PROPRIO_INSTANCE_ID;
    else process.env.PROPRIO_INSTANCE_ID = previousInstance;
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps private keys owner-only and activates only the matching one-time callback", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      if (url.endsWith("/v1/connector/enrollments")) {
        return Response.json({
          enrollmentId: "enroll-test",
          verificationUrl: "https://my.example.test/connections/enroll?id=enroll-test",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      const token = String(body.request);
      const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims).toMatchObject({
        iss: loadProprioCloudConnectorIdentity()?.instanceId,
        aud: "https://my.example.test/v1/connector/enrollment-claims",
        env: "development",
        op: "enroll",
      });
      expect(typeof claims.ah).toBe("string");
      return Response.json({
        id: loadProprioCloudConnectorIdentity()?.instanceId,
        environment: "development",
        origins: ["https://private.example.test"],
      });
    });

    const pending = await startProprioCloudConnectorEnrollment({
      origin: "https://private.example.test",
      env: {
        PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: request as typeof fetch,
    });
    expect(pending.status).toBe("pending");
    expect(pending.verificationUrl).toBe("https://my.example.test/connections/enroll?id=enroll-test");
    expect(statSync(path.dirname(proprioCloudConnectorIdentityPath())).mode & 0o777).toBe(0o700);
    expect(statSync(proprioCloudConnectorIdentityPath()).mode & 0o777).toBe(0o600);
    expect(readFileSync(proprioCloudConnectorIdentityPath(), "utf8")).not.toContain("approval-code");

    await expect(completeProprioCloudConnectorEnrollment({
      enrollmentId: "enroll-test",
      approvalCode: "approval-code",
      state: "wrong-state",
      request: request as typeof fetch,
    })).rejects.toThrow(/Invalid or expired/);

    const state = loadProprioCloudConnectorIdentity()?.pending?.returnState;
    const active = await completeProprioCloudConnectorEnrollment({
      enrollmentId: "enroll-test",
      approvalCode: "approval-code",
      state: state!,
      request: request as typeof fetch,
    });
    expect(active).toMatchObject({ configured: true, status: "active", origins: ["https://private.example.test"] });
    const config = proprioCloudConnectorConfigFromEnv({});
    expect(config).toMatchObject({ baseUrl: "https://my.example.test", environment: "development" });
    expect(requests).toHaveLength(2);

    const statusRequest = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://my.example.test/v1/connector/instance-status");
      return Response.json({ active: false, status: "suspended" });
    });
    await expect(reconcileProprioCloudConnectorEnrollmentStatus({}, statusRequest as typeof fetch)).resolves.toMatchObject({
      configured: false,
      status: "suspended",
      instanceId: active.instanceId,
    });
  });

  it("rejects non-loopback plain HTTP destinations before creating keys", async () => {
    await expect(startProprioCloudConnectorEnrollment({
      origin: "http://private.example.test",
      request: vi.fn() as typeof fetch,
    })).rejects.toThrow(/requires HTTPS/);
    expect(proprioCloudConnectorEnrollmentStatus().status).toBe("not_configured");
  });

  it.each([
    "https://my.example.test/connections/enroll?id=another-enrollment",
    "https://my.example.test/connections/enroll",
    "https://my.example.test/connections/enroll?id=enroll-test&next=%2Faccount",
    "https://my.example.test/connections/enroll?id=enroll-test#fragment",
    "https://user@my.example.test/connections/enroll?id=enroll-test",
  ])("rejects an imprecise broker verification destination: %s", async (verificationUrl) => {
    await expect(startProprioCloudConnectorEnrollment({
      origin: "https://private.example.test",
      env: {
        PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: vi.fn(async () => Response.json({
        enrollmentId: "enroll-test",
        verificationUrl,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 })) as typeof fetch,
    })).rejects.toThrow(/invalid enrollment destination/);
  });

  it("serializes overlapping starts and reuses one unexpired enrollment", async () => {
    let releaseBroker!: () => void;
    const brokerMayRespond = new Promise<void>((resolve) => {
      releaseBroker = resolve;
    });
    const request = vi.fn(async () => {
      await brokerMayRespond;
      return Response.json({
        enrollmentId: "enroll-shared",
        verificationUrl: "https://my.example.test/connections/enroll?id=enroll-shared",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 });
    });
    const values = {
      origin: "https://private.example.test",
      companyId: "company-test",
      initiatedBy: "user:admin-test",
      env: {
        PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my.example.test",
        PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "development",
      },
      request: request as typeof fetch,
    };

    const first = startProprioCloudConnectorEnrollment(values);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const second = startProprioCloudConnectorEnrollment(values);
    releaseBroker();

    const [firstStatus, secondStatus] = await Promise.all([first, second]);
    expect(request).toHaveBeenCalledOnce();
    expect(firstStatus).toMatchObject({ status: "pending", verificationUrl: expect.stringContaining("enroll-shared") });
    expect(secondStatus).toEqual(firstStatus);
    expect(loadProprioCloudConnectorIdentity()?.pending).toMatchObject({
      enrollmentId: "enroll-shared",
      companyId: "company-test",
      initiatedBy: "user:admin-test",
    });
    await expect(startProprioCloudConnectorEnrollment({
      ...values,
      initiatedBy: "user:another-admin",
    })).rejects.toThrow(/another administrator/);
    await expect(startProprioCloudConnectorEnrollment({
      ...values,
      companyId: "another-company",
    })).rejects.toThrow(/another company/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("defaults an enrollment to the environment of the standard Cloud broker", () => {
    expect(proprioCloudConnectorEnrollmentStatus({})).toMatchObject({
      brokerBaseUrl: "https://my.paperclip.app",
      environment: "production",
    });
    expect(proprioCloudConnectorEnrollmentStatus({
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
    })).toMatchObject({ environment: "staging" });
    expect(proprioCloudConnectorEnrollmentStatus({
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://test.paperclip.app",
    })).toMatchObject({ environment: "test" });
  });

  it.each(["development", "staging", "production"])("rejects %s identity at the test broker", (environment) => {
    expect(() => proprioCloudConnectorEnrollmentStatus({
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://test.paperclip.app",
      PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: environment,
    })).toThrow(/broker and environment do not match/);
  });

  it("persists test enrollment identity and signs requests for the test broker", async () => {
    const origin = "https://tenant.test.paperclip.app";
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith("/enrollments")) {
        expect(body).toMatchObject({ environment: "test", origin });
        return Response.json({ enrollmentId: "enroll-test", verificationUrl: "https://test.paperclip.app/connections/enroll?id=enroll-test", expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
      }
      const claims = JSON.parse(Buffer.from(body.request.split(".")[1], "base64url").toString("utf8"));
      expect(claims).toMatchObject({ env: "test", aud: "https://test.paperclip.app/v1/connector/enrollment-claims" });
      return Response.json({ id: loadProprioCloudConnectorIdentity()!.instanceId, environment: "test", origins: [origin] });
    });
    const env = { PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://test.paperclip.app" };
    await startProprioCloudConnectorEnrollment({ origin, env, request: request as typeof fetch });
    const pending = loadProprioCloudConnectorIdentity()!;
    await completeProprioCloudConnectorEnrollment({ enrollmentId: "enroll-test", approvalCode: "approval-code", state: pending.pending!.returnState, env, request: request as typeof fetch });
    expect(proprioCloudConnectorConfigFromEnv(env)).toMatchObject({ environment: "test", baseUrl: "https://test.paperclip.app", instanceId: pending.instanceId });
  });

  it("rotates a non-active identity instead of mixing enrollment targets", async () => {
    const origin = "https://private.example.test";
    const productionRequest = vi.fn(async () => Response.json({
      enrollmentId: "enroll-production",
      verificationUrl: "https://my.paperclip.app/connections/enroll?id=enroll-production",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, { status: 201 }));
    await startProprioCloudConnectorEnrollment({
      origin,
      env: { PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app" },
      request: productionRequest as typeof fetch,
    });
    const productionIdentity = loadProprioCloudConnectorIdentity()!;

    expect(proprioCloudConnectorEnrollmentStatus({
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
    })).toEqual({
      configured: false,
      status: "unverified",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: null,
      environment: "staging",
      origins: [],
    });

    const stagingRequest = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://my-staging.paperclip.app/v1/connector/enrollments");
      expect(JSON.parse(String(init?.body))).toMatchObject({ environment: "staging", origin });
      return Response.json({
        enrollmentId: "enroll-staging",
        verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-staging",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 });
    });
    const stagingStatus = await startProprioCloudConnectorEnrollment({
      origin,
      env: { PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app" },
      request: stagingRequest as typeof fetch,
    });
    const stagingIdentity = loadProprioCloudConnectorIdentity()!;

    expect(stagingStatus).toMatchObject({
      status: "pending",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      environment: "staging",
      verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-staging",
    });
    expect(stagingIdentity.instanceId).not.toBe(productionIdentity.instanceId);
    expect(stagingIdentity.signPublicKey).not.toBe(productionIdentity.signPublicKey);
    expect(stagingIdentity.sealPublicKey).not.toBe(productionIdentity.sealPublicKey);
    expect(stagingRequest).toHaveBeenCalledOnce();
  });

  it("fails closed when the configured target changes during callback or after activation", async () => {
    const origin = "https://private.example.test";
    const productionEnv = {
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app",
      PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "production",
    };
    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/connector/enrollments")) {
        return Response.json({
          enrollmentId: "enroll-production",
          verificationUrl: "https://my.paperclip.app/connections/enroll?id=enroll-production",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      return Response.json({
        id: loadProprioCloudConnectorIdentity()?.instanceId,
        environment: "production",
        origins: [origin],
      });
    });
    await startProprioCloudConnectorEnrollment({ origin, env: productionEnv, request: request as typeof fetch });
    const pending = loadProprioCloudConnectorIdentity()!;
    const changedTargetRequest = vi.fn();

    await expect(completeProprioCloudConnectorEnrollment({
      enrollmentId: "enroll-production",
      approvalCode: "approval-code",
      state: pending.pending!.returnState,
      env: {
        PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
        PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
      },
      request: changedTargetRequest as typeof fetch,
    })).rejects.toThrow(/Invalid or expired/);
    expect(changedTargetRequest).not.toHaveBeenCalled();

    await completeProprioCloudConnectorEnrollment({
      enrollmentId: "enroll-production",
      approvalCode: "approval-code",
      state: pending.pending!.returnState,
      env: productionEnv,
      request: request as typeof fetch,
    });
    const activeIdentity = loadProprioCloudConnectorIdentity()!;
    const activeSwitchRequest = vi.fn();
    const stagingEnv = {
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
      PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
    };

    await expect(startProprioCloudConnectorEnrollment({
      origin,
      env: stagingEnv,
      request: activeSwitchRequest as typeof fetch,
    })).rejects.toThrow(/another target/);
    expect(activeSwitchRequest).not.toHaveBeenCalled();
    expect(loadProprioCloudConnectorIdentity()).toEqual(activeIdentity);
    expect(proprioCloudConnectorConfigFromEnv(stagingEnv)).toBeNull();
  });

  it("treats managed environment identity as an atomic override of local identity", async () => {
    const origin = "https://private.example.test";
    const productionEnv = {
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app",
      PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "production",
    };
    const request = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/connector/enrollments")) {
        return Response.json({
          enrollmentId: "enroll-production",
          verificationUrl: "https://my.paperclip.app/connections/enroll?id=enroll-production",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      return Response.json({
        id: loadProprioCloudConnectorIdentity()?.instanceId,
        environment: "production",
        origins: [origin],
      });
    });
    await startProprioCloudConnectorEnrollment({ origin, env: productionEnv, request: request as typeof fetch });
    const pending = loadProprioCloudConnectorIdentity()!;
    await completeProprioCloudConnectorEnrollment({
      enrollmentId: "enroll-production",
      approvalCode: "approval-code",
      state: pending.pending!.returnState,
      env: productionEnv,
      request: request as typeof fetch,
    });
    const localIdentity = loadProprioCloudConnectorIdentity()!;

    const managedEnv = {
      PROPRIO_CLOUD_CONNECTOR_INSTANCE_ID: "managed-staging-instance",
      PROPRIO_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "managed-signing-key",
      PROPRIO_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: "managed-sealing-key",
      PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
      PROPRIO_PUBLIC_URL: "https://managed-stack.example.test",
    };
    expect(proprioCloudConnectorEnrollmentStatus(managedEnv)).toEqual({
      configured: true,
      status: "active",
      brokerBaseUrl: "https://my-staging.paperclip.app",
      instanceId: "managed-staging-instance",
      environment: "staging",
      origins: ["https://managed-stack.example.test"],
    });
    expect(proprioCloudConnectorConfigFromEnv(managedEnv)).toMatchObject({
      baseUrl: "https://my-staging.paperclip.app",
      instanceId: "managed-staging-instance",
      environment: "staging",
      signPrivateKey: "managed-signing-key",
      sealPrivateKey: "managed-sealing-key",
    });
    expect(loadProprioCloudConnectorIdentity()).toEqual(localIdentity);

    for (const omitted of [
      "PROPRIO_CLOUD_CONNECTOR_INSTANCE_ID",
      "PROPRIO_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY",
      "PROPRIO_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY",
      "PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT",
    ] as const) {
      const partialManagedEnv: NodeJS.ProcessEnv = { ...managedEnv };
      delete partialManagedEnv[omitted];
      expect(proprioCloudConnectorEnrollmentStatus(partialManagedEnv)).toMatchObject({
        configured: false,
        status: "unverified",
        instanceId: null,
        environment: "staging",
      });
      expect(() => proprioCloudConnectorConfigFromEnv(partialManagedEnv)).toThrow(/incomplete/);
      expect(loadProprioCloudConnectorIdentity()).toEqual(localIdentity);
    }

    expect(proprioCloudConnectorConfigFromEnv(productionEnv)).toMatchObject({
      baseUrl: localIdentity.brokerBaseUrl,
      instanceId: localIdentity.instanceId,
      environment: localIdentity.environment,
      signPrivateKey: localIdentity.signPrivateKey,
      sealPrivateKey: localIdentity.sealPrivateKey,
    });
  });

  it("rejects known Cloud broker and environment mismatches", () => {
    const managedIdentity = {
      PROPRIO_CLOUD_CONNECTOR_INSTANCE_ID: "managed-instance",
      PROPRIO_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "managed-signing-key",
      PROPRIO_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: "managed-sealing-key",
    };
    const mismatches = [
      {
        ...managedIdentity,
        PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my.paperclip.app",
        PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
      },
      {
        ...managedIdentity,
        PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
        PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "production",
      },
    ];
    for (const env of mismatches) {
      expect(() => proprioCloudConnectorEnrollmentStatus(env)).toThrow(/do not match/);
      expect(() => proprioCloudConnectorConfigFromEnv(env)).toThrow(/do not match/);
    }
    expect(() => proprioCloudConnectorEnrollmentStatus({
      PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
    })).toThrow(/do not match/);
  });

  it("does not create or complete self-host enrollment with managed identity configuration", async () => {
    const origin = "https://private.example.test";
    const localEnv = {
      PROPRIO_CLOUD_CONNECTOR_BASE_URL: "https://my-staging.paperclip.app",
      PROPRIO_CLOUD_CONNECTOR_ENVIRONMENT: "staging",
    };
    const enrollmentRequest = vi.fn(async () => Response.json({
      enrollmentId: "enroll-local",
      verificationUrl: "https://my-staging.paperclip.app/connections/enroll?id=enroll-local",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }, { status: 201 }));
    await startProprioCloudConnectorEnrollment({
      origin,
      env: localEnv,
      request: enrollmentRequest as typeof fetch,
    });
    const pendingIdentity = loadProprioCloudConnectorIdentity()!;
    const managedEnv = {
      ...localEnv,
      PROPRIO_CLOUD_CONNECTOR_INSTANCE_ID: "managed-staging-instance",
      PROPRIO_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "managed-signing-key",
      PROPRIO_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: "managed-sealing-key",
    };
    const managedRequest = vi.fn();

    await expect(startProprioCloudConnectorEnrollment({
      origin,
      env: managedEnv,
      request: managedRequest as typeof fetch,
    })).rejects.toThrow(/unavailable with managed identity/);
    await expect(completeProprioCloudConnectorEnrollment({
      enrollmentId: "enroll-local",
      approvalCode: "approval-code",
      state: pendingIdentity.pending!.returnState,
      env: managedEnv,
      request: managedRequest as typeof fetch,
    })).rejects.toThrow(/Invalid or expired/);
    expect(managedRequest).not.toHaveBeenCalled();
    expect(loadProprioCloudConnectorIdentity()).toEqual(pendingIdentity);
  });

  it("does not treat legacy Proprio ID keys as a Cloud enrollment", () => {
    expect(proprioCloudConnectorEnrollmentStatus({
      PROPRIO_ID_CONNECTOR_INSTANCE_ID: "legacy-instance",
      PROPRIO_ID_CONNECTOR_SIGN_PRIVATE_KEY: "legacy-signing-key",
      PROPRIO_ID_CONNECTOR_SEAL_PRIVATE_KEY: "legacy-sealing-key",
      PROPRIO_ID_CONNECTOR_ENVIRONMENT: "production",
      PROPRIO_ID_CONNECTOR_BASE_URL: "https://id.paperclip.app",
    })).toMatchObject({
      configured: false,
      status: "not_configured",
      brokerBaseUrl: "https://my.paperclip.app",
      instanceId: null,
    });
  });
});
