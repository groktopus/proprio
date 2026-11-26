import { ipKeyGenerator, rateLimit } from "express-rate-limit";

export function evidenceHistoryRateLimit(message: string) {
  return rateLimit({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: req => {
      const actor = req.actor;
      if (actor?.type === "agent" && actor.companyId && actor.agentId) return `agent:${actor.companyId}:${actor.agentId}`;
      if (actor?.type === "board" && actor.userId) return `user:${actor.userId}`;
      return ipKeyGenerator(req.socket.remoteAddress ?? "0.0.0.0");
    },
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: message },
  });
}
