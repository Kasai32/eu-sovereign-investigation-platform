import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";
import { ClauseBuilder } from "../lib/clauseBuilder.js";

const ROLES = ["analyst", "supervisor", "compliance", "admin"];
const CLEARANCES = ["PUBLIC", "INTERNAL", "SENSITIVE", "RESTRICTED"];

// S7: user/role/clearance administration. Admin-only, enforced at the route (defense-in-depth)
// AND at the database (app_users_update policy from Phase 0) — a routing bug here still can't
// grant a role change past RLS.
const adminRoutes: FastifyPluginAsync = async (app) => {
  app.get("/admin/users", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    if (request.ctx.actorRole !== "admin") return reply.code(403).send({ error: "admin only" });

    const users = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT id, email, display_name, role, clearance, is_active, created_at FROM app_users ORDER BY display_name`,
      );
      return rows;
    });
    reply.send({ users });
  });

  app.patch("/admin/users/:id", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    if (request.ctx.actorRole !== "admin") return reply.code(403).send({ error: "admin only" });
    const { id } = request.params as { id: string };
    const body = request.body as { role?: string; clearance?: string; isActive?: boolean; purpose?: string };

    if (body.role && !ROLES.includes(body.role)) return reply.code(400).send({ error: `role must be one of ${ROLES.join(", ")}` });
    if (body.clearance && !CLEARANCES.includes(body.clearance)) {
      return reply.code(400).send({ error: `clearance must be one of ${CLEARANCES.join(", ")}` });
    }

    const result = await withRequestContext(request.ctx, async (client) => {
      const set = new ClauseBuilder().add("role", body.role).add("clearance", body.clearance).add("is_active", body.isActive);
      if (set.isEmpty) return { error: "nothing to update" as const };
      const idIdx = set.param(id);

      await client.query(`UPDATE app_users SET ${set.set()} WHERE id = $${idIdx}`, set.values);
      const { rows } = await client.query(
        `SELECT id, email, display_name, role, clearance, is_active FROM app_users WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) return null;

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "admin.user.update",
        resourceType: "app_user",
        resourceId: id,
        purpose: body.purpose ?? "user role/clearance updated by administrator",
        details: { role: body.role, clearance: body.clearance, isActive: body.isActive },
      });

      return { user: rows[0] };
    });

    if (result === null) return reply.code(404).send({ error: "not found" });
    if ("error" in result) return reply.code(400).send({ error: result.error });
    reply.send(result.user);
  });
};

export default adminRoutes;
