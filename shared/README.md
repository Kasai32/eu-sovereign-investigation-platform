# shared

Zod schemas that are the single source of truth for a route's request/response shape, imported
by both `api` (validates what it actually sends) and `web` (validates what it actually
received) — see `DECISIONS.md` for why this exists (PRD v1.1 N5: frontend/backend type drift).

`api` and `web` are two independent npm projects, not an npm-workspaces monorepo. This directory
is shared purely via relative-path TypeScript imports, not a package boundary — see the tsconfig
`include` entries and `web/vite.config.ts`'s `server.fs.allow` for the minimum wiring that makes
that work. `shared/package.json` exists only to pin this directory's module kind to ESM
unambiguously for both projects' resolvers; it has no dependencies or scripts of its own — `zod`
is a normal dependency of both `api` and `web`.

## Adding a schema for another route

1. Add `shared/schemas/<route>.ts`. Export a Zod schema per request/response shape, plus
   `z.infer` type aliases for anything call sites need to name.
2. On the API side, `import` it from the route file (NodeNext requires the `.js` extension on
   the relative import even though the source is `.ts` — same convention every other relative
   import in `api/src` already follows) and call `.parse()` on the constructed response object
   right before `reply.send(...)`. A route handler whose query no longer matches the declared
   shape throws instead of silently sending something else.
3. On the web side, import the same schema in the relevant `web/src/lib/api/*.ts` module and
   validate the fetched JSON through it (see `getCase` in `cases.ts` for the pattern) instead of
   the bare `request<T>(...)` type-assertion every other call site still uses. Re-export the
   inferred type from `web/src/lib/api/types.ts` under whatever name existing call sites already
   import, so this is a non-breaking change to every file that consumes it.
4. Delete the hand-written type(s) this replaces from `types.ts`.

This is deliberately per-route and incremental — there's no requirement (or expectation) to
migrate every route in one pass. `GET /cases/:id` is the first; `POST /cases/:id/notes`'
response shape (declared as `CaseNote` — `{id, body, author_id, author_name, created_at}` — but
actually returned as just `{id, body, created_at}`, per `api/src/routes/cases/workspace.ts`) is
a second, already-known real drift worth doing next.
