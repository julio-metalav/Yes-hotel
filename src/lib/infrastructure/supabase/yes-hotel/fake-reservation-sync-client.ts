/**
 * Fake Supabase mínimo para testes do SupabaseReservationSyncRepository.
 * Estado compartilhado entre duas instâncias do repository = idempotência entre invocações.
 * Sem rede.
 */

export type FakeRow = Record<string, unknown> & { id: string };

export type FakeReservationSyncDb = {
  pms_reservas: FakeRow[];
  pms_hospedes: FakeRow[];
  pms_reserva_hospedes: FakeRow[];
  pms_sync_runs: FakeRow[];
  pms_sync_errors: FakeRow[];
  operacional_reservas: FakeRow[];
  operacional_hospedes: FakeRow[];
  operacional_reserva_eventos: FakeRow[];
};

export function createEmptyFakeReservationSyncDb(): FakeReservationSyncDb {
  return {
    pms_reservas: [],
    pms_hospedes: [],
    pms_reserva_hospedes: [],
    pms_sync_runs: [],
    pms_sync_errors: [],
    operacional_reservas: [],
    operacional_hospedes: [],
    operacional_reserva_eventos: [],
  };
}

function rid(): string {
  return `fake-${Math.random().toString(36).slice(2, 10)}`;
}

type Filter = { col: string; op: "eq" | "in"; value: unknown };

class FakeQuery {
  private filters: Filter[] = [];
  private _limit: number | null = null;
  private mode: "select" | "insert" | "upsert" | "update" | "delete" = "select";
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private onConflict: string | null = null;
  private selectCols = "*";
  private wantSingle = false;
  private wantMaybe = false;

  constructor(
    private readonly db: FakeReservationSyncDb,
    private readonly table: keyof FakeReservationSyncDb,
  ) {}

  select(_cols?: string) {
    this.selectCols = _cols || "*";
    return this;
  }

  insert(row: Record<string, unknown> | Record<string, unknown>[]) {
    this.mode = "insert";
    this.payload = row;
    return this;
  }

  upsert(row: Record<string, unknown> | Record<string, unknown>[], opts?: { onConflict?: string }) {
    this.mode = "upsert";
    this.payload = row;
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }

  update(row: Record<string, unknown>) {
    this.mode = "update";
    this.payload = row;
    return this;
  }

  delete() {
    this.mode = "delete";
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push({ col, op: "eq", value });
    return this;
  }

  in(col: string, values: unknown[]) {
    this.filters.push({ col, op: "in", value: values });
    return this;
  }

  order() {
    return this;
  }

  limit(n: number) {
    this._limit = n;
    return this;
  }

  single() {
    this.wantSingle = true;
    return this;
  }

  maybeSingle() {
    this.wantMaybe = true;
    return this;
  }

  private match(row: FakeRow): boolean {
    return this.filters.every((f) => {
      if (f.op === "eq") return row[f.col] === f.value;
      if (f.op === "in") return (f.value as unknown[]).includes(row[f.col]);
      return true;
    });
  }

  private conflictKeys(): string[] {
    if (!this.onConflict) return [];
    return this.onConflict.split(",").map((s) => s.trim()).filter(Boolean);
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled as never, onrejected as never);
  }

  private execute(): { data: unknown; error: null } {
    const table = this.db[this.table];

    if (this.mode === "insert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const inserted: FakeRow[] = [];
      for (const r of rows) {
        const row = { ...r, id: (r.id as string) || rid() } as FakeRow;
        table.push(row);
        inserted.push(row);
      }
      const data = this.wantSingle || this.wantMaybe ? inserted[0] ?? null : inserted;
      return { data, error: null };
    }

    if (this.mode === "upsert") {
      const rows = Array.isArray(this.payload) ? this.payload : [this.payload!];
      const keys = this.conflictKeys();
      const out: FakeRow[] = [];
      for (const r of rows) {
        let existing: FakeRow | undefined;
        if (keys.length > 0) {
          existing = table.find((row) => keys.every((k) => row[k] === r[k]));
        }
        if (existing) {
          Object.assign(existing, r);
          out.push(existing);
        } else {
          const row = { ...r, id: (r.id as string) || rid() } as FakeRow;
          table.push(row);
          out.push(row);
        }
      }
      const data = this.wantSingle || this.wantMaybe ? out[0] ?? null : out;
      return { data, error: null };
    }

    if (this.mode === "update") {
      const matched = table.filter((r) => this.match(r));
      for (const row of matched) Object.assign(row, this.payload as Record<string, unknown>);
      const data = this.wantSingle || this.wantMaybe ? matched[0] ?? null : matched;
      return { data, error: null };
    }

    if (this.mode === "delete") {
      const keep: FakeRow[] = [];
      const removed: FakeRow[] = [];
      for (const row of table) {
        if (this.match(row)) removed.push(row);
        else keep.push(row);
      }
      this.db[this.table] = keep;
      return { data: removed, error: null };
    }

    // select
    let rows = table.filter((r) => this.match(r));
    if (this._limit != null) rows = rows.slice(0, this._limit);
    if (this.wantSingle) {
      if (rows.length !== 1) {
        return { data: null, error: null };
      }
      return { data: rows[0], error: null };
    }
    if (this.wantMaybe) {
      return { data: rows[0] ?? null, error: null };
    }
    return { data: rows, error: null };
  }
}

/** Client mínimo compatível com o subset usado pelo repository. */
export type FakeReservationSyncClient = {
  from: (table: keyof FakeReservationSyncDb) => FakeQuery;
  __db: FakeReservationSyncDb;
};

export function createFakeReservationSyncClient(
  db: FakeReservationSyncDb = createEmptyFakeReservationSyncDb(),
): FakeReservationSyncClient {
  return {
    __db: db,
    from(table: keyof FakeReservationSyncDb) {
      return new FakeQuery(db, table);
    },
  };
}
