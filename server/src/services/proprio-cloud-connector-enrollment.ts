import path from "node:path";
import { resolveProprioInstanceRoot } from "../home-paths.js";

const ENROLLMENT_FILE = "proprio-cloud-connector.json";

export type LocalConnectorEnvironment = "development" | "test" | "staging" | "production";

type PendingEnrollment = {
  enrollmentId: string;
  returnState: string;
  origin: string;
  expiresAt: string;
  companyId?: string;
  initiatedBy?: string;
  returnTo?: string;
};

export type ProprioCloudConnectorIdentity = {
  version: 1;
  instanceId: string;
  environment: LocalConnectorEnvironment;
  brokerBaseUrl: string;
  signPrivateKey: string;
  signPublicKey: string;
  sealPrivateKey: string;
  sealPublicKey: string;
  status: "unenrolled" | "pending" | "active";
  origins: string[];
  pending?: PendingEnrollment;
  enrolledAt?: string;
};

export type ProprioCloudConnectorEnrollmentStatus = {
  configured: boolean;
  status: ProprioCloudConnectorIdentity["status"] | "not_configured" | "suspended" | "unverified";
  brokerBaseUrl: string;
  instanceId: string | null;
  environment: LocalConnectorEnvironment;
  origins: string[];
  verificationUrl?: string;
  expiresAt?: string;
};

export function proprioCloudConnectorIdentityPath(): string {
  return path.join(resolveProprioInstanceRoot(), "secrets", ENROLLMENT_FILE);
}

export function loadProprioCloudConnectorIdentity(): ProprioCloudConnectorIdentity | null { return null; }

export function proprioCloudConnectorEnrollmentStatus(
  _env: NodeJS.ProcessEnv = process.env,
): ProprioCloudConnectorEnrollmentStatus {
  return { configured: false, status: "not_configured", brokerBaseUrl: "", instanceId: null, environment: "development", origins: [] };
}

export async function startProprioCloudConnectorEnrollment(_input: {
  origin: string;
  label?: string;
  companyId?: string;
  initiatedBy?: string;
  returnTo?: string;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}): Promise<ProprioCloudConnectorEnrollmentStatus> {
  throw new Error("Managed cloud connector enrollment is not available in this release.");
}

export async function completeProprioCloudConnectorEnrollment(_input: {
  enrollmentId: string;
  approvalCode: string;
  state: string;
  env?: NodeJS.ProcessEnv;
  request?: typeof fetch;
}): Promise<ProprioCloudConnectorEnrollmentStatus> {
  throw new Error("Managed cloud connector enrollment is not available in this release.");
}
