// A query builder with the same call shape as supabase-js, so the code that
// was written against the hosted database keeps working unchanged:
//
//   const { data, error } = await db.from("emails").select("id").eq("is_read", false);
//
// The builder only records the query. The function passed in as `run` decides
// where it executes: directly on SQLite inside the server (db.ts), or as a POST
// to the server from the interface (frontend/src/lib/db.ts). This file has no
// imports so both sides can share it.

export type Filter =
  | { col: string; op: string; val: unknown; neg?: boolean; raw?: boolean }
  | { or: string };

export type Order = { col: string; ascending: boolean; nullsFirst: boolean };

export type QuerySpec = {
  table: string;
  action: "select" | "insert" | "update" | "upsert" | "delete";
  columns: string | null; // what to return; null means no rows back
  values?: unknown;
  filters: Filter[];
  order: Order[];
  limit?: number;
  offset?: number;
  single?: "one" | "maybe";
  count?: boolean;
  head?: boolean;
  onConflict?: string;
  ignoreDuplicates?: boolean;
};

export type QueryError = { message: string; code?: string; details?: string; hint?: string };

// Rows come back untyped, exactly as they did from supabase-js without
// generated types, so existing call sites typecheck as before.
export type Result = { data: any; error: QueryError | null; count: number | null; status: number };

export type Runner = (spec: QuerySpec) => Promise<Result>;

export class Query implements PromiseLike<Result> {
  spec: QuerySpec;
  run: Runner;

  constructor(run: Runner, table: string) {
    this.run = run;
    this.spec = { table, action: "select", columns: "*", filters: [], order: [] };
  }

  select(columns = "*", opts?: { count?: string; head?: boolean }): this {
    this.spec.columns = columns;
    if (opts?.count) this.spec.count = true;
    if (opts?.head) this.spec.head = true;
    return this;
  }

  insert(values: unknown, opts?: { count?: string }): this {
    this.spec.action = "insert";
    this.spec.values = values;
    this.spec.columns = null;
    if (opts?.count) this.spec.count = true;
    return this;
  }

  upsert(values: unknown, opts?: { onConflict?: string; ignoreDuplicates?: boolean; count?: string }): this {
    this.spec.action = "upsert";
    this.spec.values = values;
    this.spec.columns = null;
    this.spec.onConflict = opts?.onConflict;
    this.spec.ignoreDuplicates = opts?.ignoreDuplicates;
    if (opts?.count) this.spec.count = true;
    return this;
  }

  update(values: unknown, opts?: { count?: string }): this {
    this.spec.action = "update";
    this.spec.values = values;
    this.spec.columns = null;
    if (opts?.count) this.spec.count = true;
    return this;
  }

  delete(opts?: { count?: string }): this {
    this.spec.action = "delete";
    this.spec.columns = null;
    if (opts?.count) this.spec.count = true;
    return this;
  }

  private add(col: string, op: string, val: unknown, extra: { neg?: boolean; raw?: boolean } = {}): this {
    this.spec.filters.push({ col, op, val, ...extra });
    return this;
  }

  eq(col: string, val: unknown) { return this.add(col, "eq", val); }
  neq(col: string, val: unknown) { return this.add(col, "neq", val); }
  gt(col: string, val: unknown) { return this.add(col, "gt", val); }
  gte(col: string, val: unknown) { return this.add(col, "gte", val); }
  lt(col: string, val: unknown) { return this.add(col, "lt", val); }
  lte(col: string, val: unknown) { return this.add(col, "lte", val); }
  like(col: string, val: string) { return this.add(col, "like", val); }
  ilike(col: string, val: string) { return this.add(col, "ilike", val); }
  is(col: string, val: null | boolean) { return this.add(col, "is", val); }
  in(col: string, vals: readonly unknown[]) { return this.add(col, "in", [...vals]); }
  contains(col: string, val: unknown) { return this.add(col, "cs", val); }
  containedBy(col: string, val: unknown) { return this.add(col, "cd", val); }
  overlaps(col: string, val: unknown) { return this.add(col, "ov", val); }
  textSearch(col: string, query: string, _opts?: unknown) { return this.add(col, "fts", query); }

  // PostgREST string forms: .not("resolved_at", "is", null), .filter("x", "gte", "3")
  not(col: string, op: string, val: unknown) { return this.add(col, op, val, { neg: true, raw: true }); }
  filter(col: string, op: string, val: unknown) { return this.add(col, op, val, { raw: true }); }

  // PostgREST logic tree: "sender.ilike.%a%,and(is_read.eq.false,is_starred.eq.true)"
  or(expr: string, _opts?: unknown): this {
    this.spec.filters.push({ or: expr });
    return this;
  }

  match(obj: Record<string, unknown>): this {
    for (const [col, val] of Object.entries(obj)) this.add(col, "eq", val);
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const ascending = opts?.ascending ?? true;
    // Postgres puts nulls last when ascending and first when descending.
    this.spec.order.push({ col, ascending, nullsFirst: opts?.nullsFirst ?? !ascending });
    return this;
  }

  limit(n: number): this {
    this.spec.limit = n;
    return this;
  }

  range(from: number, to: number): this {
    this.spec.offset = from;
    this.spec.limit = to - from + 1;
    return this;
  }

  // The type argument is accepted for compatibility and ignored.
  single<_T = unknown>(): this {
    this.spec.single = "one";
    return this;
  }

  maybeSingle<_T = unknown>(): this {
    this.spec.single = "maybe";
    return this;
  }

  abortSignal(_signal: unknown): this {
    return this;
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.run(this.spec).then(onfulfilled, onrejected);
  }
}
