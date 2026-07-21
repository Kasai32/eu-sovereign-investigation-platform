import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../../db.js";
import { writeAudit } from "../../audit.js";
import { LOCKED_STATUSES } from "./shared.js";

// S2: case workspace — entities, notes, activity, members, graph seed, pin/unpin.
const casesWorkspaceRoutes: FastifyPluginAsync = async (app) => {
  // S2: case workspace — entities, notes, activity, members in one call.
  app.get("/cases/:id", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { purpose } = request.query as { purpose?: string };
    if (!purpose) return reply.code(400).send({ error: "purpose query param is required to open a case" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows: caseRows } = await client.query(`SELECT * FROM cases WHERE id = $1`, [id]);
      if (caseRows.length === 0) return null;

      const { rows: entities } = await client.query(
        `SELECT ce.object_id, ot.name AS object_type, o.properties, o.classification, ce.pinned_by, ce.pinned_at
         FROM case_entities ce
         JOIN objects o ON o.id = ce.object_id
         JOIN object_types ot ON ot.id = o.object_type_id
         WHERE ce.case_id = $1`,
        [id],
      );
      const { rows: notes } = await client.query(
        `SELECT cn.id, cn.body, cn.author_id, au.display_name AS author_name, cn.created_at
         FROM case_notes cn JOIN app_users au ON au.id = cn.author_id
         WHERE cn.case_id = $1 ORDER BY cn.created_at ASC`,
        [id],
      );
      const { rows: activity } = await client.query(
        `SELECT ca.id, ca.action, ca.details, ca.actor_id, au.display_name AS actor_name, ca.occurred_at
         FROM case_activity ca JOIN app_users au ON au.id = ca.actor_id
         WHERE ca.case_id = $1 ORDER BY ca.occurred_at ASC`,
        [id],
      );
      const { rows: members } = await client.query(
        `SELECT cm.user_id, au.display_name, au.role
         FROM case_members cm JOIN app_users au ON au.id = cm.user_id WHERE cm.case_id = $1`,
        [id],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.read",
        resourceType: "case",
        resourceId: id,
        purpose,
      });

      return { case: caseRows[0], entities, notes, activity, members };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    reply.send(result);
  });

  app.post("/cases/:id/notes", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { body: noteBody, purpose } = request.body as { body?: string; purpose?: string };
    if (!noteBody) return reply.code(400).send({ error: "body is required" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows: caseRows } = await client.query(`SELECT status FROM cases WHERE id = $1`, [id]);
      if (caseRows.length === 0) return null;
      if (LOCKED_STATUSES.has(caseRows[0].status)) {
        return { error: `case is ${caseRows[0].status} and cannot be modified` as const };
      }

      // Same RETURNING-vs-case_visible() limitation as case creation — see the comment there.
      const noteId = randomUUID();
      await client.query(
        `INSERT INTO case_notes (id, case_id, author_id, body) VALUES ($1, $2, $3, $4)`,
        [noteId, id, request.ctx!.userId, noteBody],
      );
      const { rows } = await client.query(
        `SELECT id, body, created_at FROM case_notes WHERE id = $1`,
        [noteId],
      );
      await client.query(
        `INSERT INTO case_activity (case_id, actor_id, action, details) VALUES ($1, $2, 'note_added', '{}')`,
        [id, request.ctx!.userId],
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.note.create",
        resourceType: "case",
        resourceId: id,
        purpose: purpose ?? "investigation note added",
      });
      return { note: rows[0] };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    if ("error" in result) return reply.code(409).send({ error: result.error });
    reply.code(201).send(result.note);
  });

  // Seeds the S2 graph canvas: the case's pinned entities as nodes, plus edges among just
  // those objects (interactive expansion from a node uses /graph/expand separately).
  app.get("/cases/:id/graph", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows: entityRows } = await client.query(
        `SELECT object_id FROM case_entities WHERE case_id = $1`,
        [id],
      );
      const ids = entityRows.map((r) => r.object_id);
      if (ids.length === 0) return { nodes: [], edges: [] };

      const { rows: nodes } = await client.query(
        `SELECT o.id, ot.name AS object_type, o.properties, o.classification
         FROM objects o JOIN object_types ot ON ot.id = o.object_type_id
         WHERE o.id = ANY($1::uuid[])`,
        [ids],
      );
      const { rows: edges } = await client.query(
        `SELECT e.id, e.source_object_id, e.target_object_id, rt.name AS relationship,
                e.properties, e.classification
         FROM edges e JOIN relationship_types rt ON rt.id = e.relationship_type_id
         WHERE e.source_object_id = ANY($1::uuid[]) AND e.target_object_id = ANY($1::uuid[])`,
        [ids],
      );

      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.graph.view",
        resourceType: "case",
        resourceId: id,
        purpose: "viewing case investigation graph",
      });

      return { nodes, edges };
    });

    reply.send(result);
  });

  app.post("/cases/:id/entities", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { objectId, purpose } = request.body as { objectId?: string; purpose?: string };
    if (!objectId) return reply.code(400).send({ error: "objectId is required" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows: caseRows } = await client.query(`SELECT status FROM cases WHERE id = $1`, [id]);
      if (caseRows.length === 0) return null;
      if (LOCKED_STATUSES.has(caseRows[0].status)) {
        return { error: `case is ${caseRows[0].status} and cannot be modified` as const };
      }

      await client.query(
        `INSERT INTO case_entities (case_id, object_id, pinned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, objectId, request.ctx!.userId],
      );
      await client.query(
        `INSERT INTO case_activity (case_id, actor_id, action, details) VALUES ($1, $2, 'entity_pinned', $3::jsonb)`,
        [id, request.ctx!.userId, JSON.stringify({ objectId })],
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.entity.pin",
        resourceType: "case",
        resourceId: id,
        purpose: purpose ?? "entity pinned to case",
        details: { objectId },
      });
      return { ok: true as const };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    if ("error" in result) return reply.code(409).send({ error: result.error });
    reply.send(result);
  });

  app.delete("/cases/:id/entities/:objectId", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id, objectId } = request.params as { id: string; objectId: string };
    const { purpose } = (request.query as { purpose?: string }) ?? {};

    const result = await withRequestContext(request.ctx, async (client) => {
      const { rows: caseRows } = await client.query(`SELECT status FROM cases WHERE id = $1`, [id]);
      if (caseRows.length === 0) return null;
      if (LOCKED_STATUSES.has(caseRows[0].status)) {
        return { error: `case is ${caseRows[0].status} and cannot be modified` as const };
      }

      await client.query(`DELETE FROM case_entities WHERE case_id = $1 AND object_id = $2`, [id, objectId]);
      await client.query(
        `INSERT INTO case_activity (case_id, actor_id, action, details) VALUES ($1, $2, 'entity_unpinned', $3::jsonb)`,
        [id, request.ctx!.userId, JSON.stringify({ objectId })],
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.entity.unpin",
        resourceType: "case",
        resourceId: id,
        purpose: purpose ?? "entity removed from case",
        details: { objectId },
      });
      return { ok: true as const };
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    if ("error" in result) return reply.code(409).send({ error: result.error });
    reply.send(result);
  });
};

export default casesWorkspaceRoutes;
