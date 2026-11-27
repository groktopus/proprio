import { Router, type Request } from "express";
import type { Db } from "@groktopus/db";
import { githubNativeSetupSchema, isUuidLike } from "@groktopus/shared";
import { forbidden, notFound } from "../errors.js";
import { accessService } from "../services/access.js";
import { assertAgentConnectionInstallAccess } from "../services/connection-management.js";
import { githubNativeGitService } from "../services/github-native-git.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function githubNativeGitRoutes(db: Db) {
  const router = Router();
  const service = githubNativeGitService(db);
  const access = accessService(db);
  const path = "/companies/:companyId/github-native-git";

  async function authorize(req: Request, companyId: string, agentId?: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId ?? "local-board";
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin
      && !await access.hasPermission(companyId, "user", userId, "tools:manage_connections")) {
      throw forbidden("Managing GitHub App grants requires connection management access.");
    }
    if (agentId) await assertAgentConnectionInstallAccess(db, req.actor, companyId, [agentId]);
    return userId;
  }

  router.get(path, async (req, res) => {
    const companyId = req.params.companyId as string;
    await authorize(req, companyId);
    res.json(await service.list(companyId));
  });

  router.get(`${path}/eligible-agents`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await authorize(req, companyId);
    res.json(await service.eligibleAgentIds(companyId));
  });

  router.post(path, async (req, res) => {
    const companyId = req.params.companyId as string;
    const input = githubNativeSetupSchema.parse(req.body);
    const userId = await authorize(req, companyId, input.agentId);
    res.json(await service.configure(companyId, userId, input, async () => {
      await authorize(req, companyId, input.agentId);
    }));
  });

  router.delete(`${path}/:grantId`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.grantId as string;
    await authorize(req, companyId);
    const grant = isUuidLike(id) && await service.get(companyId, id);
    if (!grant) throw notFound("GitHub App grant not found.");
    const userId = await authorize(req, companyId, grant.agentId);
    res.json(await service.revoke(companyId, id, userId, async () => {
      await authorize(req, companyId, grant.agentId);
    }));
  });

  return router;
}
