/**
 * A tiny parameterized-clause accumulator. Before this existed, four route files
 * (objects.ts, cases.ts, audit.ts, admin.ts) each hand-rolled the same
 * `conditions: string[]` / `params: unknown[]` / `.push()` / `.join(" AND ")` pattern
 * independently for building optional WHERE filters (and, in admin.ts, an UPDATE SET list).
 * One shared, reviewed implementation instead of four copies that could silently drift out of
 * sync (e.g. one file's `??` vs another's `!== undefined` skipping empty strings differently).
 *
 * Every value still goes through a `$N` placeholder — this only assembles the SQL text around
 * them, never a raw value, so it carries no injection risk beyond what direct query() calls
 * already had.
 */
export class ClauseBuilder {
  private clauses: string[] = [];
  private params: unknown[] = [];

  /** Adds `column OP $N` only if value is present (skips undefined/null/""), matching every
   * existing call site's "optional filter" semantics. */
  add(column: string, value: unknown, op: "=" | ">=" | "<=" = "="): this {
    if (value === undefined || value === null || value === "") return this;
    this.params.push(value);
    this.clauses.push(`${column} ${op} $${this.params.length}`);
    return this;
  }

  /** For a condition that doesn't fit the simple `column op $N` shape. */
  addRaw(build: (paramIndex: number) => string, value: unknown): this {
    if (value === undefined || value === null || value === "") return this;
    this.params.push(value);
    this.clauses.push(build(this.params.length));
    return this;
  }

  /** Appends a value not tied to any WHERE/SET clause (e.g. LIMIT), returning its $N index. */
  param(value: unknown): number {
    this.params.push(value);
    return this.params.length;
  }

  get values(): unknown[] {
    return this.params;
  }

  get isEmpty(): boolean {
    return this.clauses.length === 0;
  }

  /** `WHERE a = $1 AND b = $2`, or `""` if nothing was added. */
  where(): string {
    return this.clauses.length ? `WHERE ${this.clauses.join(" AND ")}` : "";
  }

  /** `a = $1, b = $2` for an UPDATE ... SET list. */
  set(): string {
    return this.clauses.join(", ");
  }
}
