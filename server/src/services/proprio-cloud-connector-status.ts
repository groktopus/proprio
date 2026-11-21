import {
  proprioCloudConnectorEnrollmentStatus,
  type ProprioCloudConnectorEnrollmentStatus,
} from "./proprio-cloud-connector-enrollment.js";
import {
  createProprioCloudConnector,
  proprioCloudConnectorConfigFromEnv,
} from "./proprio-cloud-connector.js";

export async function reconcileProprioCloudConnectorEnrollmentStatus(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<ProprioCloudConnectorEnrollmentStatus> {
  const local = proprioCloudConnectorEnrollmentStatus(env);
  if (!local.configured) return local;
  const config = proprioCloudConnectorConfigFromEnv(env);
  if (!config) return { ...local, configured: false, status: "not_configured" };
  try {
    const status = await createProprioCloudConnector({ config, request }).getInstanceStatus();
    if (status === "active") return { ...local, configured: true, status: "active" };
    if (status === "suspended") return { ...local, configured: false, status: "suspended" };
    return { ...local, configured: false, status: "not_configured" };
  } catch {
    return { ...local, configured: false, status: "unverified" };
  }
}
