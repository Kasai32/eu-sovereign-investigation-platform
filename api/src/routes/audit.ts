import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";
import { ClauseBuilder } from "../lib/clauseBuilder.js";

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
    const q = request.query as {
      userId?: string;
      action?: string;
      resourceType?: string;
      from?: string;
      to?: string;
      limit?: string;
      purpose?: string;
    };
    if (!q.purpose) return reply.code(400).send({ error: "purpose query param is required to view the audit log" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const filter = new ClauseBuilder()
        .add("a.user_id", q.userId)
        .add("a.action", q.action)
        .add("a.resource_type", q.resourceType)
        .add("a.occurred_at", q.from, ">=")
        .add("a.occurred_at", q.to, "<=");
      const limitIdx = filter.param(Math.min(Number(q.limit ?? 100), 500));
      const { rows: entries } = await client.query(
        `SELECT a.seq, a.user_id, u.display_name AS user_name, a.action, a.resource_type, a.resource_id,
                a.purpose, a.details, a.occurred_at
         FROM audit_log a LEFT JOIN app_users u ON u.id = a.user_id
         ${filter.where()} ORDER BY a.seq DESC LIMIT $${limitIdx}`,
        filter.values,
      );
      const { rows: chainCheck } = await client.query(`SELECT * FROM verify_audit_log()`);

      // Meta-audit: viewing the audit log is itself logged, same table, same schema.
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "audit.read",
        purpose: q.purpose!,
        details: { userIdFilter: q.userId, actionFilter: q.action, resourceTypeFilter: q.resourceType, from: q.from, to: q.to },
      });

      return { entries, chain: chainCheck[0] };
    });

    reply.send(result);
  });
};

export default auditRoutes;
