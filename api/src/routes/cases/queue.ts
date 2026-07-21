import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../../db.js";
import { writeAudit } from "../../audit.js";
import { ClauseBuilder } from "../../lib/clauseBuilder.js";

// S1: case queue — list and create.
const casesQueueRoutes: FastifyPluginAsync = async (app) => {
  app.get("/cases", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const q = request.query as { status?: string; assignedTo?: string; purpose?: string };

    const cases = await withRequestContext(request.ctx, async (client) => {
      const filter = new ClauseBuilder().add("c.status", q.status).add("c.assigned_to", q.assignedTo);
      const { rows } = await client.query(
        `SELECT c.id, c.title, c.status, c.priority, c.classification, c.assigned_to, c.created_by, c.created_at,
                (SELECT count(*) FROM case_entities ce WHERE ce.case_id = c.id) AS entity_count
         FROM cases c ${filter.where()} ORDER BY c.created_at DESC LIMIT 100`,
        filter.values,
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.list",
        purpose: q.purpose ?? "case queue browse",
        details: { status: q.status, assignedTo: q.assignedTo },
      });
      return rows;
    });

    reply.send({ cases });
  });

  app.post("/cases", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const body = request.body as { title?: string; classification?: string; priority?: string; purpose?: string };
    if (!body.title) return reply.code(400).send({ error: "title is required" });

    const created = await withRequestContext(request.ctx, async (client) => {
      // Deliberately no RETURNING on this INSERT: cases_select's policy calls case_visible(),
      // a SECURITY DEFINER function that re-queries `cases`. Its STABLE snapshot is fixed at
      // statement start, so it cannot see a row inserted by that same statement — Postgres
      // then rejects the RETURNING re-check with "new row violates row-level security policy",
      // even though the INSERT's own WITH CHECK passed. Generating the id up front and reading
      // it back with a separate SELECT (a new statement, new snapshot) sidesteps this cleanly.
      const id = randomUUID();
      await client.query(
        `INSERT INTO cases (id, title, status, priority, classification, created_by)
         VALUES ($1, $2, 'open', $3, $4, $5)`,
        [id, body.title, body.priority ?? "normal", body.classification ?? "INTERNAL", request.ctx!.userId],
      );
      const { rows } = await client.query(
        `SELECT id, title, status, priority, classification, created_at FROM cases WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      await client.query(
        `INSERT INTO case_members (case_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [row.id, request.ctx!.userId],
      );
      await client.query(
        `INSERT INTO case_activity (case_id, actor_id, action, details) VALUES ($1, $2, 'case_created', '{}')`,
        [row.id, request.ctx!.userId],
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.create",
        resourceType: "case",
        resourceId: row.id,
        purpose: body.purpose ?? "new case opened from alert/referral",
      });
      return row;
    });

    reply.code(201).send(created);
  });
};

export default casesQueueRoutes;
