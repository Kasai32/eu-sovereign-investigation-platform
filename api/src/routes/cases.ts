import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";
import { writeAudit } from "../audit.js";

const STATUSES = ["open", "under_review", "closed", "archived"] as const;

const casesRoutes: FastifyPluginAsync = async (app) => {
  // S1: case queue.
  app.get("/cases", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const q = request.query as { status?: string; assignedTo?: string; purpose?: string };

    const cases = await withRequestContext(request.ctx, async (client) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (q.status) {
        params.push(q.status);
        conditions.push(`c.status = $${params.length}`);
      }
      if (q.assignedTo) {
        params.push(q.assignedTo);
        conditions.push(`c.assigned_to = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const { rows } = await client.query(
        `SELECT c.id, c.title, c.status, c.priority, c.classification, c.assigned_to, c.created_by, c.created_at,
                (SELECT count(*) FROM case_entities ce WHERE ce.case_id = c.id) AS entity_count
         FROM cases c ${where} ORDER BY c.created_at DESC LIMIT 100`,
        params,
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

    const note = await withRequestContext(request.ctx, async (client) => {
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
      return rows[0];
    });

    reply.code(201).send(note);
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

    await withRequestContext(request.ctx, async (client) => {
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
    });

    reply.send({ ok: true });
  });

  app.delete("/cases/:id/entities/:objectId", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id, objectId } = request.params as { id: string; objectId: string };
    const { purpose } = (request.query as { purpose?: string }) ?? {};

    await withRequestContext(request.ctx, async (client) => {
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
    });

    reply.send({ ok: true });
  });

  // Closing freezes an evidence snapshot (the specific object/edge IDs relied on) so later
  // ingestion or merges never silently rewrite a finalized report's basis.
  app.patch("/cases/:id/status", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });
    const { id } = request.params as { id: string };
    const { status, purpose } = request.body as { status?: string; purpose?: string };
    if (!status || !STATUSES.includes(status as (typeof STATUSES)[number])) {
      return reply.code(400).send({ error: `status must be one of ${STATUSES.join(", ")}` });
    }
    if (!purpose) return reply.code(400).send({ error: "purpose is required to change case status" });

    const result = await withRequestContext(request.ctx, async (client) => {
      const params: unknown[] = [status, id];
      let extraSet = "";
      if (status === "closed") {
        const { rows: entityRows } = await client.query(`SELECT object_id FROM case_entities WHERE case_id = $1`, [id]);
        const objectIds = entityRows.map((r) => r.object_id);
        const { rows: edgeRows } = objectIds.length
          ? await client.query(
              `SELECT id FROM edges WHERE source_object_id = ANY($1::uuid[]) AND target_object_id = ANY($1::uuid[])`,
              [objectIds],
            )
          : { rows: [] as { id: string }[] };
        const snapshot = { objectIds, edgeIds: edgeRows.map((r) => r.id), frozenAt: new Date().toISOString() };
        params.push(JSON.stringify(snapshot));
        extraSet = `, evidence_snapshot = $3::jsonb, closed_at = now()`;
      }
      const { rows } = await client.query(
        `UPDATE cases SET status = $1, updated_at = now() ${extraSet} WHERE id = $2
         RETURNING id, status, evidence_snapshot, closed_at`,
        params,
      );
      if (rows.length === 0) return null;
      await client.query(
        `INSERT INTO case_activity (case_id, actor_id, action, details) VALUES ($1, $2, 'status_changed', $3::jsonb)`,
        [id, request.ctx!.userId, JSON.stringify({ status })],
      );
      await writeAudit(client, {
        userId: request.ctx!.userId,
        action: "case.status_change",
        resourceType: "case",
        resourceId: id,
        purpose,
        details: { status },
      });
      return rows[0];
    });

    if (!result) return reply.code(404).send({ error: "not found" });
    reply.send(result);
  });
};

export default casesRoutes;
