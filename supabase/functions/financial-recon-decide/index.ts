import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  applyReviewDecisions,
  assertReviewDtoSafe,
  buildConfirmMatchPlan,
  buildInternalTransferPlan,
  buildReviewOnlyPlan,
  collectConservativeCandidates,
  explainEvidence,
  friendlyDecideError,
  INVALID_FINANCIAL_ENTRY_ID,
  isDecideAction,
  isFinancialEntryUuid,
  maskFitid,
  maskPersonName,
  parseOptionalFinancialEntryId,
  pendingCounts,
  redactDescription,
  resolveReviewCaseIds,
  sameDecision,
  toReconEntry,
  type HumanReviewRecord,
  type ReconEntry,
} from "../../../src/lib/financial/reconciliation/index.ts";
import { HUMAN_REVIEW_RULE_VERSION } from "../../../src/lib/financial/reconciliation/human-review.ts";
import { ANALYSIS_ENTRY_SELECT, ANALYSIS_SOURCE_KINDS } from "../../../src/lib/financial/reconciliation/review-view.ts";
import { scoreOmieBankPair } from "../../../src/lib/financial/reconciliation/score.ts";

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
  if (userError || !user) throw Object.assign(new Error("Login necessario."), { status: 401 });
  const { data: profile, error: profileError } = await adminClient
    .from("usuarios_internos")
    .select("id, perfil_usuario, ativo")
    .eq("auth_user_id", user.id)
    .maybeSingle();
  if (profileError || !profile || profile.perfil_usuario !== "admin" || profile.ativo !== true) {
    throw Object.assign(new Error("Acesso restrito a admin."), { status: 403 });
  }
  return { id: String(profile.id), role: "admin" as const };
}

async function fetchAll<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
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

async function loadAccountCodeById(): Promise<Map<string, string>> {
  const { data, error } = await adminClient.from("financial_accounts").select("id, code");
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((row) => [String(row.id), String(row.code)]));
}

function attachAccountCode(row: Record<string, unknown>, accounts: ReadonlyMap<string, string>): Record<string, unknown> {
  const accountId = row.account_id == null ? null : String(row.account_id);
  return { ...row, account_code: accountId ? accounts.get(accountId) ?? null : null };
}

async function loadEntriesByIds(ids: string[]): Promise<ReconEntry[]> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  if (unique.some((id) => !isFinancialEntryUuid(id))) {
    throw Object.assign(new Error(INVALID_FINANCIAL_ENTRY_ID), { status: 400 });
  }
  const accounts = await loadAccountCodeById();
  const { data, error } = await adminClient
    .from("financial_entries")
    .select(`${ANALYSIS_ENTRY_SELECT}, open_amount_cents, source_record_id, financial_accounts ( code, account_mask )`)
    .in("id", unique)
    .eq("lifecycle_status", "active");
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => toReconEntry(attachAccountCode(row as Record<string, unknown>, accounts)));
}

async function loadPeriodEntries(periodStart: string, periodEnd: string): Promise<ReconEntry[]> {
  const accounts = await loadAccountCodeById();
  const rows = await fetchAll<Record<string, unknown>>((from, to) =>
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
  );
  return rows.map((row) => toReconEntry(attachAccountCode(row, accounts)));
}

async function loadUsedEntryIds(): Promise<Set<string>> {
  const rows = await fetchAll<{ entry_id: string }>((from, to) =>
    adminClient.from("financial_reconciliation_legs").select("entry_id").order("entry_id").range(from, to),
  );
  return new Set(rows.map((row) => String(row.entry_id)));
}

async function loadGroupKeys(): Promise<Set<string>> {
  const rows = await fetchAll<{ reconciliation_key: string | null }>((from, to) =>
    adminClient
      .from("financial_reconciliation_groups")
      .select("reconciliation_key")
      .not("reconciliation_key", "is", null)
      .order("reconciliation_key")
      .range(from, to),
  );
  return new Set(rows.map((row) => String(row.reconciliation_key)));
}

async function loadReviews(): Promise<HumanReviewRecord[]> {
  const rows = await fetchAll<Record<string, unknown>>((from, to) =>
    adminClient
      .from("financial_reconciliation_reviews")
      .select(
        "review_key, review_type, status, action, omie_entry_id, bank_entry_id, candidate_entry_ids, resulting_group_id",
      )
      .order("created_at", { ascending: false })
      .range(from, to),
  );
  return rows.map((row) => ({
    review_key: String(row.review_key),
    review_type: row.review_type as HumanReviewRecord["review_type"],
    status: row.status as HumanReviewRecord["status"],
    action: String(row.action),
    omie_entry_id: row.omie_entry_id == null ? null : String(row.omie_entry_id),
    bank_entry_id: row.bank_entry_id == null ? null : String(row.bank_entry_id),
    candidate_entry_ids: Array.isArray(row.candidate_entry_ids) ? row.candidate_entry_ids.map(String) : [],
    resulting_group_id: row.resulting_group_id == null ? null : String(row.resulting_group_id),
  }));
}

function sanitizeEntry(entry: ReconEntry, extra?: { account_mask?: string | null }) {
  const isOmie = entry.source_system === "omie";
  return {
    id: entry.id,
    source_system: entry.source_system,
    source_kind: entry.source_kind,
    type: entry.source_kind === "omie_receivable" ? "AR" : entry.source_kind === "omie_payable" ? "AP" : null,
    settlement_date: entry.settlement_date,
    person_name_masked: isOmie ? maskPersonName(entry.person_name) : null,
    gross_amount_cents: entry.gross_amount_cents,
    settled_amount_cents: entry.settled_amount_cents,
    open_amount_cents: entry.open_amount_cents,
    amount_cents: isOmie ? entry.settled_amount_cents : entry.gross_amount_cents,
    account_code: entry.account_code,
    account_mask: extra?.account_mask ?? null,
    direction: entry.direction,
    description_redacted: isOmie ? null : redactDescription(entry.description),
    fitid_masked: isOmie ? null : maskFitid(entry.source_record_id),
  };
}

async function insertReview(row: Record<string, unknown>) {
  const { data, error } = await adminClient
    .from("financial_reconciliation_reviews")
    .insert(row)
    .select("id, review_key, status, action, resulting_group_id, created_at")
    .maybeSingle();
  if (error && (error.code === "23505" || String(error.message).includes("financial_reconciliation_reviews_key_uidx"))) {
    return { conflict: true as const, row: null };
  }
  if (error) throw Object.assign(new Error(error.message), { status: 409 });
  return { conflict: false as const, row: data };
}

async function existingReview(reviewKey: string) {
  const { data, error } = await adminClient
    .from("financial_reconciliation_reviews")
    .select("review_key, review_type, status, action, omie_entry_id, bank_entry_id, candidate_entry_ids, resulting_group_id")
    .eq("review_key", reviewKey)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function persistConfirm(
  plan: ReturnType<typeof buildConfirmMatchPlan>,
  actor: { id: string; role: "admin" },
  reason: string | null,
) {
  const existing = await existingReview(plan.review_key);
  if (existing) {
    if (sameDecision(existing as HumanReviewRecord, plan)) {
      return { idempotent: true, review: existing, group_id: existing.resulting_group_id };
    }
    throw Object.assign(new Error("Já existe decisão diferente para este caso."), { status: 409 });
  }
  const used = await loadUsedEntryIds();
  const keys = await loadGroupKeys();
  const involved = [plan.omie_entry_id, plan.bank_entry_id, plan.debit_entry_id, plan.credit_entry_id].filter(Boolean);
  for (const id of involved) {
    if (id && used.has(id)) throw Object.assign(new Error("Entry já pertence a um grupo de conciliação."), { status: 409 });
  }
  if (keys.has(plan.reconciliation_key)) {
    throw Object.assign(new Error("Já existe grupo com esta reconciliation_key."), { status: 409 });
  }

  const { data: group, error: groupError } = await adminClient
    .from("financial_reconciliation_groups")
    .insert({
      status: "confirmed",
      match_method: plan.match_method,
      rule_version: HUMAN_REVIEW_RULE_VERSION,
      confidence: plan.confidence,
      matched_amount_cents: plan.matched_amount_cents,
      score_evidence: plan.score_evidence,
      reconciliation_key: plan.reconciliation_key,
      reviewed_by: actor.id,
      reviewed_at: new Date().toISOString(),
      review_note: reason,
    })
    .select("id")
    .single();
  if (groupError) throw Object.assign(new Error(groupError.message), { status: 409 });

  const legs =
    plan.match_method === "internal_transfer"
      ? [
          { group_id: group.id, entry_id: plan.debit_entry_id, role: "source", allocated_amount_cents: plan.matched_amount_cents },
          { group_id: group.id, entry_id: plan.credit_entry_id, role: "target", allocated_amount_cents: plan.matched_amount_cents },
        ]
      : [
          { group_id: group.id, entry_id: plan.omie_entry_id, role: "source", allocated_amount_cents: plan.matched_amount_cents },
          { group_id: group.id, entry_id: plan.bank_entry_id, role: "target", allocated_amount_cents: plan.matched_amount_cents },
        ];
  const { error: legError } = await adminClient.from("financial_reconciliation_legs").insert(legs);
  if (legError) {
    await adminClient.from("financial_reconciliation_groups").delete().eq("id", group.id);
    throw Object.assign(new Error(legError.message.includes("entry") ? "Entry já pertence a um grupo de conciliação." : legError.message), {
      status: 409,
    });
  }

  const inserted = await insertReview({
    review_key: plan.review_key,
    review_type: plan.review_type,
    status: plan.status,
    action: plan.action,
    omie_entry_id: plan.omie_entry_id,
    bank_entry_id: plan.bank_entry_id,
    candidate_entry_ids: plan.candidate_entry_ids,
    resulting_group_id: group.id,
    rule_version: HUMAN_REVIEW_RULE_VERSION,
    score: plan.confidence,
    score_evidence: plan.score_evidence,
    actor_user_id: actor.id,
    actor_role: actor.role,
    reason,
    previous_state: plan.previous_state,
  });
  if (inserted.conflict) {
    const again = await existingReview(plan.review_key);
    return { idempotent: true, review: again, group_id: group.id };
  }
  return { idempotent: false, review: inserted.row, group_id: group.id };
}

async function persistReviewOnly(
  plan: ReturnType<typeof buildReviewOnlyPlan>,
  actor: { id: string; role: "admin" },
  reason: string | null,
) {
  const existing = await existingReview(plan.review_key);
  if (existing) {
    if (sameDecision(existing as HumanReviewRecord, plan)) {
      return { idempotent: true, review: existing, group_id: null };
    }
    throw Object.assign(new Error("Já existe decisão diferente para este caso."), { status: 409 });
  }
  const inserted = await insertReview({
    review_key: plan.review_key,
    review_type: plan.review_type,
    status: plan.status,
    action: plan.action,
    omie_entry_id: plan.omie_entry_id,
    bank_entry_id: plan.bank_entry_id,
    candidate_entry_ids: plan.candidate_entry_ids,
    resulting_group_id: null,
    rule_version: HUMAN_REVIEW_RULE_VERSION,
    score: plan.score,
    score_evidence: plan.score_evidence,
    actor_user_id: actor.id,
    actor_role: actor.role,
    reason,
    previous_state: plan.previous_state,
  });
  if (inserted.conflict) {
    const again = await existingReview(plan.review_key);
    if (again && sameDecision(again as HumanReviewRecord, plan)) {
      return { idempotent: true, review: again, group_id: null };
    }
    throw Object.assign(new Error("Já existe decisão diferente para este caso."), { status: 409 });
  }
  return { idempotent: false, review: inserted.row, group_id: null };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);
  try {
    const actor = await ensureAdminCaller(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action;
    if (!isDecideAction(action)) return jsonResponse({ error: "action invalida." }, 400);
    const reason = body.reason == null ? null : String(body.reason).slice(0, 500);
    if ("score" in body || "score_evidence" in body || "actor_user_id" in body) {
      return jsonResponse({ error: "score, evidence e actor sao derivados no servidor." }, 400);
    }

    if (action === "list_reviews") {
      const reviews = await loadReviews();
      const payload = { action, reviews: reviews.map((row) => ({ ...row, actor_user_id: undefined })) };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    if (action === "review_case") {
      const ids = resolveReviewCaseIds({
        omie_entry_id: body.omie_entry_id,
        bank_entry_id: body.bank_entry_id,
        entry_id: body.entry_id,
      });
      const omieId = ids.omie_entry_id ?? "";
      const bankId = ids.bank_entry_id ?? "";
      const focusId = omieId || bankId;
      const periodStart = String(body.period_start ?? "2026-01-01");
      const periodEnd = String(body.period_end ?? "2026-07-31");
      const wanted = ids.lookup_ids;
      const [focusEntries, pool, used] = await Promise.all([
        loadEntriesByIds(wanted),
        loadPeriodEntries(periodStart, periodEnd),
        loadUsedEntryIds(),
      ]);
      const byId = new Map(focusEntries.map((row) => [row.id, row]));
      const omie = omieId ? byId.get(omieId) : focusEntries.find((row) => row.source_system === "omie");
      const bank = bankId ? byId.get(bankId) : focusEntries.find((row) => row.source_system === "sicredi");
      const focus = byId.get(focusId) ?? omie ?? bank;
      if (!focus) return jsonResponse({ error: "Caso nao encontrado." }, 404);
      const scored = omie && bank ? scoreOmieBankPair(omie, bank) : null;
      const candidates = collectConservativeCandidates(focus, pool).map((row) => ({
        ...row,
        blocked: used.has(row.entry_id),
      }));
      const payload = {
        action,
        read_only: false,
        rule_version: HUMAN_REVIEW_RULE_VERSION,
        omie: omie ? sanitizeEntry(omie) : null,
        bank: bank ? sanitizeEntry(bank) : null,
        focus: sanitizeEntry(focus),
        score: scored?.score ?? null,
        evidence_label: explainEvidence(scored?.score ?? null, scored?.evidence ?? null),
        score_evidence: scored?.evidence ?? null,
        candidates,
        used_entries: [omie?.id, bank?.id, focus.id].filter((id): id is string => !!id && used.has(id)),
        allowed_actions: used.has(focus.id)
          ? []
          : omie && bank
            ? ["confirm_match", "reject_suggestion", "reject_ambiguous"]
            : ["confirm_match", "mark_unmatched", "mark_awaiting_settlement", "mark_possible_aggregation", "mark_internal_transfer"],
      };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    const writeIds = resolveReviewCaseIds({
      omie_entry_id: body.omie_entry_id,
      bank_entry_id: body.bank_entry_id,
      entry_id: isFinancialEntryUuid(body.entry_id) ? body.entry_id : undefined,
    });
    const omieId = writeIds.omie_entry_id ?? "";
    const bankId = writeIds.bank_entry_id ?? "";
    const entryId = isFinancialEntryUuid(body.entry_id) ? String(body.entry_id).trim() : "";
    const reviewType = String(body.review_type ?? (omieId && bankId ? "suggested" : omieId ? "unmatched_omie" : "unmatched_bank"));
    const candidateIds = Array.isArray(body.candidate_entry_ids)
      ? body.candidate_entry_ids.map((id) => {
          if (!isFinancialEntryUuid(id)) {
            throw Object.assign(new Error(INVALID_FINANCIAL_ENTRY_ID), { status: 400 });
          }
          return String(id).trim();
        })
      : [];

    if (action === "confirm_match") {
      const chosenBank = parseOptionalFinancialEntryId(body.selected_bank_entry_id) ?? bankId;
      const chosenOmie = parseOptionalFinancialEntryId(body.selected_omie_entry_id) ?? omieId;
      const loaded = await loadEntriesByIds([chosenOmie, chosenBank]);
      const omie = loaded.find((row) => row.id === chosenOmie);
      const bank = loaded.find((row) => row.id === chosenBank);
      if (!omie || !bank) return jsonResponse({ error: "Entries do par nao encontradas." }, 404);
      const used = await loadUsedEntryIds();
      const keys = await loadGroupKeys();
      const plan = buildConfirmMatchPlan({
        review_type: reviewType as HumanReviewRecord["review_type"],
        omie,
        bank,
        candidate_entry_ids: candidateIds.length ? candidateIds : [chosenBank],
        used_entry_ids: used,
        existing_group_keys: keys,
        existing_review_keys: new Set(),
      });
      const saved = await persistConfirm(plan, actor, reason);
      const payload = { action, persisted: true, financial_entries_updated: false, ...saved };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    if (action === "mark_internal_transfer") {
      const debitId = parseOptionalFinancialEntryId(body.debit_entry_id) ?? "";
      const creditId = parseOptionalFinancialEntryId(body.credit_entry_id) ?? "";
      const periodStart = String(body.period_start ?? "2026-01-01");
      const periodEnd = String(body.period_end ?? "2026-07-31");
      const [pair, pool, used, keys] = await Promise.all([
        loadEntriesByIds([debitId, creditId]),
        loadPeriodEntries(periodStart, periodEnd),
        loadUsedEntryIds(),
        loadGroupKeys(),
      ]);
      const debit = pair.find((row) => row.id === debitId);
      const credit = pair.find((row) => row.id === creditId);
      if (!debit || !credit) return jsonResponse({ error: "Entries bancarias nao encontradas." }, 404);
      const plan = buildInternalTransferPlan({
        debit,
        credit,
        pool,
        used_entry_ids: used,
        existing_group_keys: keys,
      });
      const saved = await persistConfirm(plan, actor, reason);
      const payload = { action, persisted: true, financial_entries_updated: false, ...saved };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    if (
      action === "reject_suggestion" ||
      action === "reject_ambiguous" ||
      action === "mark_unmatched" ||
      action === "mark_awaiting_settlement" ||
      action === "mark_possible_aggregation"
    ) {
      const plan = buildReviewOnlyPlan({
        action,
        review_type: reviewType as HumanReviewRecord["review_type"],
        omie_entry_id: omieId || null,
        bank_entry_id: bankId || entryId || null,
        candidate_entry_ids: candidateIds,
      });
      const saved = await persistReviewOnly(plan, actor, reason);
      const payload = { action, persisted: true, financial_entries_updated: false, group_created: false, ...saved };
      assertReviewDtoSafe(payload);
      return jsonResponse(payload);
    }

    return jsonResponse({ error: "action nao implementada." }, 400);
  } catch (error) {
    const mapped = friendlyDecideError(error);
    return jsonResponse({ error: mapped.message }, mapped.status);
  }
});
