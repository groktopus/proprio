import { Router, type Request, type Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Db } from "@groktopus/db";
import { caseHandoffRecipientDecisionSchema, caseHandoffWithdrawalSchema, handoffCaseSchema } from "@groktopus/shared";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { assertAuthenticated, assertCompanyAccess, hasCompanyAccess } from "./authz.js";

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), before: z.iso.datetime().optional(), cursor: z.string().max(400).optional() });

const listOffersSchema = listSchema.omit({ before: true });

export function caseHandoffRoutes(db: Db) {
  const router = Router();
  const service = caseHandoffService(db);
  const handoffRateLimit = (limit: number, message: string) => rateLimit({
    windowMs: 60_000,
    limit,
    keyGenerator: req => req.actor?.type === "agent" && req.actor.companyId && req.actor.agentId
      ? `agent:${req.actor.companyId}:${req.actor.agentId}`
      : ipKeyGenerator(req.socket.remoteAddress ?? "0.0.0.0"),
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: message },
  });
  router.post("/companies/:companyId/case-handoffs", validate(handoffCaseSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await service.handoff(companyId, req.actor, req.body);
    res.status(result.replayed ? 200 : 202).json(result);
  });
  const listOffersRateLimit = handoffRateLimit(60, "Handoff offer list request limit exceeded");
  const decisionRateLimit = handoffRateLimit(12, "Handoff decision request limit exceeded");
  router.get("/companies/:companyId/case-handoff-offers", listOffersRateLimit, async (req, res) => {
    assertAuthenticated(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.listRecipientOffers(req.actor, companyId, listOffersSchema.parse(req.query)));
  });
  async function readableCaseId(req: Request) {
    assertAuthenticated(req);
    const caseId = req.params.caseId as string;
    const row = await service.visible(req.actor, caseId);
    if (!hasCompanyAccess(req, row.companyId)) throw notFound("Case not found");
    assertCompanyAccess(req, row.companyId);
    return caseId;
  }
  router.get("/cases/:caseId/handoffs", async (req, res) => {
    const caseId = await readableCaseId(req);
    res.json(await service.list(req.actor, caseId, listSchema.parse(req.query)));
  });
  router.get("/cases/:caseId/handoffs/:handoffId/recovery-history", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const caseId = await readableCaseId(req);
    res.json(await service.recoveryHistory(req.actor, caseId, req.params.handoffId as string));
  });
  router.post("/cases/:caseId/handoffs/:handoffId/decision", decisionRateLimit, validate(caseHandoffRecipientDecisionSchema), async (req, res) => {
    const caseId = await readableCaseId(req);
    res.json(await service.recordRecipientDecision(req.actor, caseId, req.params.handoffId as string, req.body));
  });
  const control = (action: "retry" | "cancel") => async (req: Request, res: Response) => {
    const caseId = await readableCaseId(req);
    res.json(await service[action](req.actor, caseId, req.params.handoffId as string));
  };
  router.post("/cases/:caseId/handoffs/:handoffId/retry", control("retry"));
  router.post("/cases/:caseId/handoffs/:handoffId/cancel", control("cancel"));
  router.post("/cases/:caseId/handoffs/:handoffId/withdraw", validate(caseHandoffWithdrawalSchema), async (req, res) => {
    const caseId = await readableCaseId(req);
    res.json(await service.withdrawDelivered(req.actor, caseId, req.params.handoffId as string, req.body));
  });
  return router;
}
