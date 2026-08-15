import { createClient } from "jsr:@supabase/supabase-js@2";
import { reconcileOmieSicredi } from "../../../src/lib/financial/reconciliation/engine.ts";
import {
  OMIE_SICREDI_RULE_VERSION,
  type ReconEntry,
} from "../../../src/lib/financial/reconciliation/types.ts";
import {
  ANALYSIS_ENTRY_SELECT,
  ANALYSIS_SOURCE_KINDS,
  assertReviewDtoSafe,
  buildAnalysisLists,
  filterAnalysisRows,
  isReviewAction,
  kpisFromPersisted,
  mergeAnalysisKpis,
  normalizeReviewFilters,
  paginateRows,
  sanitizePersistedDetail,
  sanitizePersistedListRow,
  toReconEntry,
  type ReviewKpis,
  type ReviewListRow,
} from "../../../src/lib/financial/reconciliation/review-view.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY sao obrigatorias.");
}

/** high_list / group_detail: precisa de FITID mascarado e máscara de conta. Sem payload bruto. */
const ENTRY_SELECT_PERSISTED =
  "id, account_id, source_system, source_kind, source_record_id, direction, person_name, description, gross_amount_cents, settled_amount_cents, open_amount_cents, settlement_date, financial_accounts ( code, account_mask )";

/** overview: só agregados. Sem nome, descrição ou payload. */
const ENTRY_SELECT_OVERVIEW =
  "id, source_system, source_kind, direction, settled_amount_cents, gross_amount_cents, settlement_date";

const WRITE_ACTIONS = new Set([
  "persist",
  "persist_high",
  "confirm",
  "reject",
  "undo",
  "apply",
  "update",
  "delete",
  "insert",
]);

const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function createRequestClient(request: Request) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: request.headers.get("Authorization") ?? "" } },
  });
}

async function ensureAdminCaller(request: Request) {
  const requestClient = createRequestClient(request);
  const {
    data: { user },
    error: userError,
  } = await requestClient.auth.getUser();
  if (userError || !user) {
    throw Object.assign(new Error("Login necessario."), { status: 401 });
  }
  const { data: profile, error: profileError } = await adminClient
    .from("usuarios_internos")
    .select("id, perfil_usuario, ativo")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (profileError || !profile || profile.perfil_usuario !== "admin" || profile.ativo !== true) {
    throw Object.assign(new Error("Acesso restrito a admin."), { status: 403 });
  }
  return profile;
}

async function fetchAll<T>(queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const pageSize = 1000;
  const rows: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryFactory(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function accountMaskOf(row: Record<string, unknown>): string | null {
  const nested = row.financial_accounts;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const mask = (nested as { account_mask?: unknown }).account_mask;
    return mask == null ? null : String(mask);
  }
  return null;
}

function inPeriod(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}

async function loadAccountCodeById(): Promise<Map<string, string>> {
  const { data, error } = await adminClient.from("financial_accounts").select("id, code");
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((row) => [String(row.id), String(row.code)]));
}

function attachAccountCode(row: Record<string, unknown>, accounts: ReadonlyMap<string, string>): Record<string, unknown> {
  const accountId = row.account_id == null ? null : String(row.account_id);
  return {
    ...row,
    account_code: row.account_code ?? (accountId ? accounts.get(accountId) ?? null : null),
  };
}

async function loadOverviewFacts(periodStart: string, periodEnd: string): Promise<ReconEntry[]> {
  const rows = await fetchAll<Record<string, unknown>>((from, to) =>
    adminClient
      .from("financial_entries")
      .select(ENTRY_SELECT_OVERVIEW)
      .eq("lifecycle_status", "active")
      .in("source_system", ["omie", "sicredi"])
      .in("source_kind", [...ANALYSIS_SOURCE_KINDS])
      .gte("settlement_date", periodStart)
      .lte("settlement_date", periodEnd)
      .order("id")
      .range(from, to),
  );
  return rows.map(toReconEntry);
}

async function loadAnalysisEntries(periodStart: string, periodEnd: string): Promise<ReconEntry[]> {
  const [accounts, rows] = await Promise.all([
    loadAccountCodeById(),
    fetchAll<Record<string, unknown>>((from, to) =>
      adminClient
        .from("financial_entries")
        .select(ANALYSIS_ENTRY_SELECT)
        .eq("lifecycle_status", "active")
        .in("source_system", ["omie", "sicredi"])
        .in("source_kind", [...ANALYSIS_SOURCE_KINDS])
        .gte("settlement_date", periodStart)
        .lte("settlement_date", periodEnd)
        .order("id")
        .range(from, to),
    ),
  ]);
  return rows.map((row) => toReconEntry(attachAccountCode(row, accounts)));
}

async function loadPeriodBounds(): Promise<{ start: string; end: string; accounts: string[] }> {
  const { data, error } = await adminClient
    .from("financial_entries")
    .select("settlement_date, financial_accounts ( code )")
    .eq("lifecycle_status", "active")
    .in("source_system", ["omie", "sicredi"])
    .not("settlement_date", "is", null)
    .order("settlement_date", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const { data: last, error: lastError } = await adminClient
    .from("financial_entries")
    .select("settlement_date")
    .eq("lifecycle_status", "active")
    .in("source_system", ["omie", "sicredi"])
    .not("settlement_date", "is", null)
    .order("settlement_date", { ascending: false })
    .limit(1);
  if (lastError) throw new Error(lastError.message);
  const { data: accounts, error: accountError } = await adminClient
    .from("financial_accounts")
    .select("code")
    .eq("kind", "bank")
    .in("code", ["sicredi_principal", "sicredi_0911"])
    .order("code");
  if (accountError) throw new Error(accountError.message);
  return {
    start: String(data?.[0]?.settlement_date ?? "2026-01-01"),
    end: String(last?.[0]?.settlement_date ?? "2026-07-31"),
    accounts: (accounts ?? []).map((row) => String(row.code)),
  };
}

function persistedKpisFromEntries(
  entries: readonly ReconEntry[],
  groups: readonly { match_method: string | null; matched_amount_cents: number | null }[],
  findingsCount: number,
): ReviewKpis {
  const omieAr = entries.filter((row) => row.source_kind === "omie_receivable");
  const omieAp = entries.filter((row) => row.source_kind === "omie_payable");
  const credits = entries.filter((row) => row.source_system === "sicredi" && row.direction === "credit");
  const debits = entries.filter((row) => row.source_system === "sicredi" && row.direction === "debit");
  const high = groups.filter((row) => row.match_method === "one_to_one");
  const transfers = groups.filter((row) => row.match_method === "internal_transfer");
  const sum = (rows: readonly ReconEntry[], pick: (row: ReconEntry) => number | null) =>
    rows.reduce((acc, row) => acc + (pick(row) ?? 0), 0);
  return kpisFromPersisted({
    omie_ar_count: omieAr.length,
    omie_ar_cents: sum(omieAr, (row) => row.settled_amount_cents),
    omie_ap_count: omieAp.length,
    omie_ap_cents: sum(omieAp, (row) => row.settled_amount_cents),
    sicredi_credit_count: credits.length,
    sicredi_credit_cents: sum(credits, (row) => row.gross_amount_cents),
    sicredi_debit_count: debits.length,
    sicredi_debit_cents: sum(debits, (row) => row.gross_amount_cents),
    high_count: high.length,
    high_cents: high.reduce((acc, row) => acc + (row.matched_amount_cents ?? 0), 0),
    transfer_count: transfers.length,
    transfer_cents: transfers.reduce((acc, row) => acc + (row.matched_amount_cents ?? 0), 0),
    persisted_findings: findingsCount,
  });
}

async function loadPersistedGroups() {
  return await fetchAll<Record<string, unknown>>((from, to) =>
    adminClient
      .from("financial_reconciliation_groups")
      .select("id, status, match_method, rule_version, confidence, matched_amount_cents, score_evidence, created_at")
      .eq("rule_version", OMIE_SICREDI_RULE_VERSION)
      .eq("status", "auto_matched")
      .order("created_at", { ascending: false })
      .range(from, to),
  );
}

async function loadLegs(groupIds: string[]) {
  if (!groupIds.length) return [];
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < groupIds.length; i += 200) {
    const chunk = groupIds.slice(i, i + 200);
    const { data, error } = await adminClient
      .from("financial_reconciliation_legs")
      .select("id, group_id, entry_id, role, allocated_amount_cents")
      .in("group_id", chunk);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }
  return rows;
}

async function loadEntriesByIds(ids: string[]) {
  if (!ids.length) return [];
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data, error } = await adminClient
      .from("financial_entries")
      .select(ENTRY_SELECT_PERSISTED)
      .in("id", chunk);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Record<string, unknown>[]));
  }
  return rows;
}

function assemblePersistedRows(
  groups: Record<string, unknown>[],
  legs: Record<string, unknown>[],
  entryRows: Record<string, unknown>[],
  filters: { period_start: string; period_end: string; origin: string; direction: string; account_code: string | null; view: string },
): ReviewListRow[] {
  const entries = new Map(entryRows.map((row) => [String(row.id), toReconEntry(row)]));
  const legsByGroup = new Map<string, Record<string, unknown>[]>();
  for (const leg of legs) {
    const groupId = String(leg.group_id);
    const list = legsByGroup.get(groupId) ?? [];
    list.push(leg);
    legsByGroup.set(groupId, list);
  }
  const rows: ReviewListRow[] = [];
  for (const group of groups) {
    const groupLegs = legsByGroup.get(String(group.id)) ?? [];
    const mapped = groupLegs.map((leg) => ({
      role: String(leg.role),
      entry: entries.get(String(leg.entry_id)) ?? null,
    }));
    const omie = mapped.find((row) => row.entry?.source_system === "omie")?.entry ?? null;
    const bank = mapped.find((row) => row.entry?.source_system === "sicredi")?.entry ?? null;
    const debit = mapped.find((row) => row.entry?.direction === "debit")?.entry ?? null;
    const credit = mapped.find((row) => row.entry?.direction === "credit")?.entry ?? null;
    const isTransfer = group.match_method === "internal_transfer";
    if (filters.view === "high" && isTransfer) continue;
    if (filters.view === "internal_transfer" && !isTransfer) continue;
    const dates = [omie, bank, debit, credit].map((row) => row?.settlement_date).filter(Boolean) as string[];
    if (dates.length && dates.every((date) => !inPeriod(date, filters.period_start, filters.period_end))) continue;
    if (filters.origin === "omie" && !omie) continue;
    if (filters.origin === "sicredi" && !bank && !debit && !credit) continue;
    if (filters.direction !== "all") {
      const dir = bank?.direction ?? debit?.direction ?? credit?.direction ?? omie?.direction;
      if (dir && dir !== filters.direction) continue;
    }
    if (filters.account_code) {
      const codes = [bank?.account_code, debit?.account_code, credit?.account_code].filter(Boolean);
      if (codes.length && !codes.includes(filters.account_code)) continue;
    }
    rows.push(
      sanitizePersistedListRow({
        id: String(group.id),
        match_method: group.match_method == null ? null : String(group.match_method),
        status: String(group.status),
        confidence: group.confidence == null ? null : Number(group.confidence),
        matched_amount_cents: group.matched_amount_cents == null ? null : Number(group.matched_amount_cents),
        score_evidence: (group.score_evidence ?? {}) as ReviewListRow extends never ? never : Parameters<typeof sanitizePersistedListRow>[0]["score_evidence"],
        rule_version: group.rule_version == null ? null : String(group.rule_version),
        omie,
        bank,
        debit,
        credit,
      }),
    );
  }
  return rows;
}

async function groupDetail(groupId: string) {
  const { data: group, error } = await adminClient
    .from("financial_reconciliation_groups")
    .select("id, status, match_method, rule_version, confidence, matched_amount_cents, score_evidence, created_at")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!group) throw Object.assign(new Error("Grupo nao encontrado."), { status: 404 });
  const legs = await loadLegs([groupId]);
  const entryRows = await loadEntriesByIds(legs.map((leg) => String(leg.entry_id)));
  const entries = new Map(entryRows.map((row) => [String(row.id), toReconEntry(row)]));
  const mapped = legs.map((leg) => entries.get(String(leg.entry_id)) ?? null);
  const omie = mapped.find((row) => row?.source_system === "omie") ?? null;
  const bank = mapped.find((row) => row?.source_system === "sicredi") ?? null;
  const debit = mapped.find((row) => row?.direction === "debit") ?? null;
  const credit = mapped.find((row) => row?.direction === "credit") ?? null;
  const maskById = new Map(entryRows.map((row) => [String(row.id), accountMaskOf(row)]));
  return sanitizePersistedDetail({
    id: String(group.id),
    match_method: group.match_method == null ? null : String(group.match_method),
    status: String(group.status),
    confidence: group.confidence == null ? null : Number(group.confidence),
    matched_amount_cents: group.matched_amount_cents == null ? null : Number(group.matched_amount_cents),
    score_evidence: group.score_evidence ?? {},
    rule_version: group.rule_version == null ? null : String(group.rule_version),
    created_at: group.created_at == null ? null : String(group.created_at),
    omie,
    bank,
    debit,
    credit,
    bank_mask: bank ? maskById.get(bank.id) ?? null : null,
    debit_mask: debit ? maskById.get(debit.id) ?? null : null,
    credit_mask: credit ? maskById.get(credit.id) ?? null : null,
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);

  try {
    await ensureAdminCaller(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? "");
    if (WRITE_ACTIONS.has(action)) {
      return jsonResponse({ error: "Revisao financeira e somente leitura. Nenhuma mutacao e permitida." }, 400);
    }
    if (!isReviewAction(action)) {
      return jsonResponse({ error: "Acao invalida." }, 400);
    }

    const bounds = await loadPeriodBounds();
    const filters = normalizeReviewFilters({
      period_start: body.period_start == null ? undefined : String(body.period_start),
      period_end: body.period_end == null ? undefined : String(body.period_end),
      origin: body.origin == null ? undefined : String(body.origin),
      view: body.view == null ? undefined : String(body.view),
      direction: body.direction == null ? undefined : String(body.direction),
      account_code: body.account_code == null ? null : String(body.account_code),
      page: body.page == null ? undefined : Number(body.page),
      page_size: body.page_size == null ? undefined : Number(body.page_size),
      defaultStart: bounds.start,
      defaultEnd: bounds.end,
    });

    if (action === "overview") {
      const [entries, groups, findings] = await Promise.all([
        loadOverviewFacts(filters.period_start, filters.period_end),
        loadPersistedGroups(),
        adminClient.from("financial_audit_findings").select("id", { count: "exact", head: true }),
      ]);
      const kpis = persistedKpisFromEntries(entries, groups, findings.count ?? 0);
      const payload = {
        action,
        read_only: true,
        rule_version: OMIE_SICREDI_RULE_VERSION,
        period_start: filters.period_start,
        period_end: filters.period_end,
        available_period: bounds,
        accounts: bounds.accounts,
        kpis,
        persisted_groups: groups.length,
        persisted_legs: null,
        rows_loaded: entries.length,
      };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    if (action === "high_list") {
      const groups = await loadPersistedGroups();
      const wanted = groups.filter((group) =>
        filters.view === "internal_transfer"
          ? group.match_method === "internal_transfer"
          : group.match_method === "one_to_one",
      );
      const legs = await loadLegs(wanted.map((group) => String(group.id)));
      const entryRows = await loadEntriesByIds(legs.map((leg) => String(leg.entry_id)));
      const rows = assemblePersistedRows(wanted, legs, entryRows, filters);
      const page = paginateRows(rows, filters.page, filters.page_size);
      const payload = {
        action,
        read_only: true,
        rule_version: OMIE_SICREDI_RULE_VERSION,
        filters,
        page,
      };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    if (action === "group_detail") {
      const groupId = String(body.group_id ?? "").trim();
      if (!groupId) return jsonResponse({ error: "group_id obrigatorio." }, 400);
      const detail = await groupDetail(groupId);
      const payload = { action, read_only: true, detail };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    const includePossibleAggregations = action === "possible_aggregations";
    const fetchStarted = Date.now();
    const [entries, persistedGroups] = await Promise.all([
      loadAnalysisEntries(filters.period_start, filters.period_end),
      loadPersistedGroups(),
    ]);
    const fetchMs = Date.now() - fetchStarted;
    const engineStarted = Date.now();
    const result = reconcileOmieSicredi({
      entries,
      periodStart: filters.period_start,
      periodEnd: filters.period_end,
      includePossibleAggregations,
      includeReportExtras: false,
    });
    const engineMs = Date.now() - engineStarted;
    const lists = buildAnalysisLists(result, entries);
    const listKey = includePossibleAggregations
      ? "possible_aggregation"
      : filters.view === "high" || filters.view === "internal_transfer"
        ? "suggested"
        : filters.view;
    const source = lists[listKey as keyof typeof lists] ?? [];
    const filtered = filterAnalysisRows(source, filters);
    const kpis = mergeAnalysisKpis(
      persistedKpisFromEntries(entries, persistedGroups, 0),
      result.stats,
    );
    const payload = {
      action,
      read_only: true,
      persisted: false,
      rule_version: result.rule_version,
      filters,
      kpis,
      unmatched_breakdown: {
        omie_ar_count: result.stats.omie_ar_unmatched_count,
        omie_ar_cents: result.stats.omie_ar_unmatched_cents,
        omie_ap_count: result.stats.omie_ap_unmatched_count,
        omie_ap_cents: result.stats.omie_ap_unmatched_cents,
        bank_credit_count: result.stats.bank_credit_unmatched_count,
        bank_credit_cents: result.stats.bank_credit_unmatched_cents,
        bank_debit_count: result.stats.bank_debit_unmatched_count,
        bank_debit_cents: result.stats.bank_debit_unmatched_cents,
      },
      possible_aggregation_breakdown: includePossibleAggregations
        ? {
            c_ar: result.stats.possible_agg_c_ar,
            d_ar: result.stats.possible_agg_d_ar,
            c_ap: result.stats.possible_agg_c_ap,
            d_ap: result.stats.possible_agg_d_ap,
          }
        : null,
      page: paginateRows(filtered, filters.page, filters.page_size),
      perf: {
        fetch_ms: fetchMs,
        engine_ms: engineMs,
        rows: entries.length,
      },
    };
    assertReviewDtoSafe(payload);
    return jsonResponse(payload);
  } catch (error) {
    const status = Number((error as { status?: number }).status ?? 400);
    return jsonResponse({ error: error instanceof Error ? error.message : "Falha na revisao financeira." }, status);
  }
});
