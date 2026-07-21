import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";

// Compliance/admin only, enforced twice: here at the route (defense-in-depth, matches the
// build prompt's "not just an app-level if-check" warning) AND at the database via
// audit_log_select_compliance — a routing bug here still can't leak rows past RLS.
const AUDIT_ROLES = ["compliance", "admin"];

const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/audit", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    if (!AUDIT_ROLES.includes(request.ctx.actorRole)) {
      return reply.code(403).send({ error: "audit log access is restricted to compliance/admin roles" });
    }
    const q = request.query as { userId?: string; action?: string; limit?: string; purpose?: string };
    if (!q.purpose) return reply.code(400).send({ error: "purpose query param is required to view the audit log" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (q.userId) {
        params.push(q.userId);
        conditions.push(`user_id = $${params.length}`);
      }
      if (q.action) {
        params.push(q.action);
        conditions.push(`action = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(Math.min(Number(q.limit ?? 100), 500));
      const { rows: entries } = await client.query(
        `SELECT seq, user_id, action, resource_type, resource_id, purpose, details, occurred_at
         FROM audit_log ${where} ORDER BY seq DESC LIMIT $${params.length}`,
        params,
      );
      const { rows: chainCheck } = await client.query(`SELECT * FROM verify_audit_log()`);

      // Meta-audit: viewing the audit log is itself logged, same table, same schema.
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "audit.read",
        purpose: q.purpose!,
        details: { userIdFilter: q.userId, actionFilter: q.action },
      });

      return { entries, chain: chainCheck[0] };
    });

    reply.send(result);
  });
};

export default auditRoutes;
