import { createHash } from "node:crypto";
import { scoreEvidenceIsStructured } from "../persistence.ts";
import { dateDistanceDays } from "./dates.ts";
import { bankMatchAmountCents, omieMatchAmountCents } from "./score.ts";
import { OMIE_SICREDI_RULE_VERSION, type ReconEntry, type ReconGroup, type ReconResult } from "./types.ts";

export const YES_HOTEL_HOMO_REF = "minmmecajnmjqlgacfoz";

export const OMIE_SICREDI_HIGH_PERSIST_EXPECT = {
  rule_version: "omie_sicredi_v1.2",
  transfer_high_count: 2,
  transfer_cents: 10000,
  high_count: 601,
  high_cents: 70821187,
  high_ar_cents: 15062161,
  high_ap_cents: 55759026,
  high_party_token_exact: 601,
  high_party_exact_normalized: 0,
  high_party_contains_safe: 0,
  high_party_no_match: 0,
  high_collision_count: 0,
  high_amount_date_only_count: 0,
} as const;

/** Contrato live da analysis V1.2 nos facts HOMO atuais, após persistir o delta de 8 high. */
export const OMIE_SICREDI_LIVE_ANALYSIS_EXPECT = {
  rule_version: "omie_sicredi_v1.2",
  period_start: "2026-01-01",
  period_end: "2026-07-31",
  high_persisted_count: 601,
  high_persisted_cents: 70821187,
  high_recomputed_count: 601,
  high_recomputed_cents: 70821187,
  high_unpersisted_count: 0,
  transfer_high_count: 2,
  transfer_cents: 10000,
  suggested_count: 819,
  suggested_cents: 74019205,
  ambiguous_count: 20,
  ambiguous_cents: 887596,
  omie_ar_unmatched_count: 495,
  omie_ar_unmatched_cents: 95167449,
  omie_ap_unmatched_count: 233,
  omie_ap_unmatched_cents: 27007294,
  bank_credit_unmatched_count: 593,
  bank_credit_unmatched_cents: 94731202,
  bank_debit_unmatched_count: 581,
  bank_debit_unmatched_cents: 33856873,
} as const;

/** Delta incremental desta rodada: 8 high AR ainda não persistidos. Sem IDs hardcoded. */
export const OMIE_SICREDI_HIGH_DELTA_EXPECT = {
  existing_one_to_one: 593,
  existing_transfers: 2,
  missing_one_to_one: 8,
  missing_cents: 399811,
  missing_score: 93,
  missing_party_match: "token_exact",
  missing_date_distance_days: 0,
} as const;

export type HighPersistMatchMethod = "one_to_one" | "internal_transfer";

export type HighPersistLeg = {
  reconciliation_key: string;
  entry_id: string;
  role: "source" | "target";
  allocated_amount_cents: number;
};

export type HighPersistGroup = {
  reconciliation_key: string;
  status: "auto_matched";
  match_method: HighPersistMatchMethod;
  rule_version: typeof OMIE_SICREDI_RULE_VERSION;
  confidence: number;
  matched_amount_cents: number;
  score_evidence: ReconGroup["score_evidence"];
  legs: HighPersistLeg[];
};

export type HighPersistPlan = {
  groups: HighPersistGroup[];
  one_to_one_count: number;
  transfer_count: number;
  leg_count: number;
  one_to_one_cents: number;
  transfer_cents: number;
  ar_cents: number;
  ap_cents: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isYesHotelHomoUrl(url: string): boolean {
  return url.includes(YES_HOTEL_HOMO_REF);
}

export function assertHomoReconciliationGate(input: {
  persistHigh: boolean;
  allowHomo: boolean;
  url?: string;
  apply: boolean;
}): void {
  if (!input.persistHigh) {
    throw new Error("Persistência recusada. Use --persist-high ou --persist-high-delta --allow-homo-reconciliation.");
  }
  if (!input.allowHomo) {
    throw new Error("Persistência recusada. Para HOMO use --persist-high ou --persist-high-delta --allow-homo-reconciliation. Nenhum dado foi gravado.");
  }
  if (input.apply) {
    const url = input.url ?? "";
    if (url && !isYesHotelHomoUrl(url)) {
      throw new Error("Persistência recusada: URL não é o HOMO Yes Hotel");
    }
  }
}

export function reconciliationKey(matchMethod: HighPersistMatchMethod, entryIds: readonly string[]): string {
  const ids = [...entryIds].map((id) => String(id)).sort();
  if (ids.length < 2) throw new Error("reconciliation_key exige pelo menos 2 entries");
  return createHash("sha256")
    .update([OMIE_SICREDI_RULE_VERSION, matchMethod, ...ids].join("|"))
    .digest("hex");
}

export function assertHighPersistSnapshot(result: ReconResult): void {
  const s = result.stats;
  const expect = OMIE_SICREDI_HIGH_PERSIST_EXPECT;
  const mismatches: string[] = [];
  if (result.rule_version !== expect.rule_version) mismatches.push(`rule_version ${result.rule_version}`);
  if (s.transfer_high_count !== expect.transfer_high_count) mismatches.push(`transfer_high_count ${s.transfer_high_count}`);
  if (s.transfer_cents !== expect.transfer_cents) mismatches.push(`transfer_cents ${s.transfer_cents}`);
  if (s.high_count !== expect.high_count) mismatches.push(`high_count ${s.high_count}`);
  if (s.high_cents !== expect.high_cents) mismatches.push(`high_cents ${s.high_cents}`);
  if (s.high_ar_cents !== expect.high_ar_cents) mismatches.push(`high_ar_cents ${s.high_ar_cents}`);
  if (s.high_ap_cents !== expect.high_ap_cents) mismatches.push(`high_ap_cents ${s.high_ap_cents}`);
  if (s.high_party_token_exact !== expect.high_party_token_exact) mismatches.push(`token_exact ${s.high_party_token_exact}`);
  if (s.high_party_exact_normalized !== expect.high_party_exact_normalized) {
    mismatches.push(`exact_normalized ${s.high_party_exact_normalized}`);
  }
  if (s.high_party_contains_safe !== expect.high_party_contains_safe) {
    mismatches.push(`contains_safe ${s.high_party_contains_safe}`);
  }
  if (s.high_party_no_match !== expect.high_party_no_match) mismatches.push(`no_match ${s.high_party_no_match}`);
  if (s.high_collision_count !== expect.high_collision_count) mismatches.push(`collision ${s.high_collision_count}`);
  if (s.high_amount_date_only_count !== expect.high_amount_date_only_count) {
    mismatches.push(`amount_date_only ${s.high_amount_date_only_count}`);
  }
  if (mismatches.length) {
    throw new Error(`Dry-run divergiu do contrato high V1.2. PARAR. Nenhum dado foi gravado.\n${mismatches.join("\n")}`);
  }
}

function assertNoReuse(groups: readonly HighPersistGroup[]): void {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const leg of group.legs) {
      if (seen.has(leg.entry_id)) {
        throw new Error(`Reuso de entry ${leg.entry_id} no plano high. PARAR.`);
      }
      seen.add(leg.entry_id);
    }
  }
}

export function buildHighPersistPlan(
  result: ReconResult,
  input: { requireExpectedSnapshot?: boolean; requireUuid?: boolean } = {},
): HighPersistPlan {
  if (input.requireExpectedSnapshot) assertHighPersistSnapshot(result);
  const groups: HighPersistGroup[] = [];

  for (const transfer of result.transfers.filter((row) => row.confidence === "high")) {
    const entryIds = [transfer.debit_entry_id, transfer.credit_entry_id];
    const key = reconciliationKey("internal_transfer", entryIds);
    if (!scoreEvidenceIsStructured(transfer.score_evidence)) {
      throw new Error(`score_evidence inválido na transferência ${key}`);
    }
    groups.push({
      reconciliation_key: key,
      status: "auto_matched",
      match_method: "internal_transfer",
      rule_version: OMIE_SICREDI_RULE_VERSION,
      confidence: 100,
      matched_amount_cents: transfer.amount_cents,
      score_evidence: transfer.score_evidence,
      legs: [
        {
          reconciliation_key: key,
          entry_id: transfer.debit_entry_id,
          role: "source",
          allocated_amount_cents: transfer.amount_cents,
        },
        {
          reconciliation_key: key,
          entry_id: transfer.credit_entry_id,
          role: "target",
          allocated_amount_cents: transfer.amount_cents,
        },
      ],
    });
  }

  for (const group of result.groups.filter((row) => row.kind === "one_to_one" && row.band === "high")) {
    const omieId = group.omie_entry_ids[0];
    const bankId = group.bank_entry_ids[0];
    if (!omieId || !bankId || group.omie_entry_ids.length !== 1 || group.bank_entry_ids.length !== 1) {
      throw new Error("1:1 high inválido: esperado exatamente 1 Omie e 1 Sicredi");
    }
    if (group.score_evidence.party_match === "no_match") {
      throw new Error("high com party_match=no_match. PARAR.");
    }
    if (!scoreEvidenceIsStructured(group.score_evidence)) {
      throw new Error("score_evidence inválido em 1:1 high. PARAR.");
    }
    const key = reconciliationKey("one_to_one", [omieId, bankId]);
    groups.push({
      reconciliation_key: key,
      status: "auto_matched",
      match_method: "one_to_one",
      rule_version: OMIE_SICREDI_RULE_VERSION,
      confidence: group.confidence,
      matched_amount_cents: group.matched_amount_cents,
      score_evidence: group.score_evidence,
      legs: [
        { reconciliation_key: key, entry_id: omieId, role: "source", allocated_amount_cents: group.matched_amount_cents },
        { reconciliation_key: key, entry_id: bankId, role: "target", allocated_amount_cents: group.matched_amount_cents },
      ],
    });
  }

  groups.sort((a, b) => a.reconciliation_key.localeCompare(b.reconciliation_key));
  assertNoReuse(groups);
  if (input.requireUuid) {
    for (const group of groups) {
      for (const leg of group.legs) {
        if (!UUID_RE.test(leg.entry_id)) throw new Error(`entry_id não é UUID: ${leg.entry_id}`);
      }
    }
  }

  const oneToOne = groups.filter((row) => row.match_method === "one_to_one");
  const transfers = groups.filter((row) => row.match_method === "internal_transfer");
  return {
    groups,
    one_to_one_count: oneToOne.length,
    transfer_count: transfers.length,
    leg_count: groups.reduce((acc, row) => acc + row.legs.length, 0),
    one_to_one_cents: oneToOne.reduce((acc, row) => acc + row.matched_amount_cents, 0),
    transfer_cents: transfers.reduce((acc, row) => acc + row.matched_amount_cents, 0),
    ar_cents: result.stats.high_ar_cents,
    ap_cents: result.stats.high_ap_cents,
  };
}

export type HighPersistKeyDiff = {
  existing_keys: number;
  existing_one_to_one: number;
  existing_transfers: number;
  extra_keys: number;
  missing_groups: HighPersistGroup[];
  missing_one_to_one: number;
  missing_transfers: number;
  missing_cents: number;
};

export function assertLiveRecomputeSnapshot(result: ReconResult): void {
  const s = result.stats;
  const expect = OMIE_SICREDI_LIVE_ANALYSIS_EXPECT;
  const mismatches: string[] = [];
  if (result.rule_version !== expect.rule_version) mismatches.push(`rule_version ${result.rule_version}`);
  if (s.high_count !== expect.high_recomputed_count) mismatches.push(`high_count ${s.high_count}`);
  if (s.high_cents !== expect.high_recomputed_cents) mismatches.push(`high_cents ${s.high_cents}`);
  if (s.suggested_count !== expect.suggested_count) mismatches.push(`suggested_count ${s.suggested_count}`);
  if (s.suggested_cents !== expect.suggested_cents) mismatches.push(`suggested_cents ${s.suggested_cents}`);
  if (s.ambiguous_count !== expect.ambiguous_count) mismatches.push(`ambiguous_count ${s.ambiguous_count}`);
  if (s.ambiguous_cents !== expect.ambiguous_cents) mismatches.push(`ambiguous_cents ${s.ambiguous_cents}`);
  if (s.transfer_high_count !== expect.transfer_high_count) {
    mismatches.push(`transfer_high_count ${s.transfer_high_count}`);
  }
  if (s.transfer_cents !== expect.transfer_cents) mismatches.push(`transfer_cents ${s.transfer_cents}`);
  if (s.omie_ar_unmatched_count !== expect.omie_ar_unmatched_count) {
    mismatches.push(`omie_ar_unmatched_count ${s.omie_ar_unmatched_count}`);
  }
  if (s.omie_ar_unmatched_cents !== expect.omie_ar_unmatched_cents) {
    mismatches.push(`omie_ar_unmatched_cents ${s.omie_ar_unmatched_cents}`);
  }
  if (s.omie_ap_unmatched_count !== expect.omie_ap_unmatched_count) {
    mismatches.push(`omie_ap_unmatched_count ${s.omie_ap_unmatched_count}`);
  }
  if (s.omie_ap_unmatched_cents !== expect.omie_ap_unmatched_cents) {
    mismatches.push(`omie_ap_unmatched_cents ${s.omie_ap_unmatched_cents}`);
  }
  if (s.bank_credit_unmatched_count !== expect.bank_credit_unmatched_count) {
    mismatches.push(`bank_credit_unmatched_count ${s.bank_credit_unmatched_count}`);
  }
  if (s.bank_credit_unmatched_cents !== expect.bank_credit_unmatched_cents) {
    mismatches.push(`bank_credit_unmatched_cents ${s.bank_credit_unmatched_cents}`);
  }
  if (s.bank_debit_unmatched_count !== expect.bank_debit_unmatched_count) {
    mismatches.push(`bank_debit_unmatched_count ${s.bank_debit_unmatched_count}`);
  }
  if (s.bank_debit_unmatched_cents !== expect.bank_debit_unmatched_cents) {
    mismatches.push(`bank_debit_unmatched_cents ${s.bank_debit_unmatched_cents}`);
  }
  if (mismatches.length) {
    throw new Error(`Dry-run live divergiu do contrato V1.2. PARAR. Nenhum dado foi gravado.\n${mismatches.join("\n")}`);
  }
}

export function diffHighPersistPlan(
  plan: HighPersistPlan,
  existingKeys: ReadonlySet<string>,
): HighPersistKeyDiff {
  const planKeys = new Set(plan.groups.map((group) => group.reconciliation_key));
  const extra_keys = [...existingKeys].filter((key) => !planKeys.has(key)).length;
  const existing = plan.groups.filter((group) => existingKeys.has(group.reconciliation_key));
  const missing = plan.groups.filter((group) => !existingKeys.has(group.reconciliation_key));
  const missingOneToOne = missing.filter((group) => group.match_method === "one_to_one");
  return {
    existing_keys: existing.length,
    existing_one_to_one: existing.filter((group) => group.match_method === "one_to_one").length,
    existing_transfers: existing.filter((group) => group.match_method === "internal_transfer").length,
    extra_keys,
    missing_groups: missing,
    missing_one_to_one: missingOneToOne.length,
    missing_transfers: missing.filter((group) => group.match_method === "internal_transfer").length,
    missing_cents: missingOneToOne.reduce((acc, group) => acc + group.matched_amount_cents, 0),
  };
}

export function assertHighDeltaCount(diff: HighPersistKeyDiff): "persist" | "idempotent" {
  const expect = OMIE_SICREDI_HIGH_DELTA_EXPECT;
  if (diff.extra_keys > 0) {
    throw new Error(`Keys persistidas fora do plano live: ${diff.extra_keys}. PARAR.`);
  }
  if (diff.missing_transfers !== 0) {
    throw new Error(`Delta inclui ${diff.missing_transfers} transfer(s). PARAR. Nenhum dado foi gravado.`);
  }
  const finalOneToOne = expect.existing_one_to_one + expect.missing_one_to_one;
  if (diff.missing_one_to_one === 0 && diff.existing_one_to_one === finalOneToOne) {
    return "idempotent";
  }
  if (diff.existing_one_to_one !== expect.existing_one_to_one) {
    throw new Error(
      `Keys 1:1 já persistidas=${diff.existing_one_to_one}, esperado ${expect.existing_one_to_one}. PARAR.`,
    );
  }
  if (diff.existing_transfers !== expect.existing_transfers) {
    throw new Error(
      `Transfers já persistidas=${diff.existing_transfers}, esperado ${expect.existing_transfers}. PARAR.`,
    );
  }
  if (diff.missing_one_to_one !== expect.missing_one_to_one) {
    throw new Error(
      `Delta 1:1=${diff.missing_one_to_one}, esperado ${expect.missing_one_to_one}. PARAR. Nenhum dado foi gravado.`,
    );
  }
  if (diff.missing_cents !== expect.missing_cents) {
    throw new Error(
      `Delta cents=${diff.missing_cents}, esperado ${expect.missing_cents}. PARAR. Nenhum dado foi gravado.`,
    );
  }
  return "persist";
}

export function toDeltaPersistPlan(diff: HighPersistKeyDiff): HighPersistPlan {
  const groups = diff.missing_groups.filter((group) => group.match_method === "one_to_one");
  return {
    groups,
    one_to_one_count: groups.length,
    transfer_count: 0,
    leg_count: groups.reduce((acc, group) => acc + group.legs.length, 0),
    one_to_one_cents: groups.reduce((acc, group) => acc + group.matched_amount_cents, 0),
    transfer_cents: 0,
    ar_cents: groups.reduce((acc, group) => acc + group.matched_amount_cents, 0),
    ap_cents: 0,
  };
}

export function assertIncrementalHighGroups(
  groups: readonly HighPersistGroup[],
  entries: readonly ReconEntry[],
  result: ReconResult,
  existingEntryIds: ReadonlySet<string>,
): void {
  const expect = OMIE_SICREDI_HIGH_DELTA_EXPECT;
  if (groups.length !== expect.missing_one_to_one) {
    throw new Error(`Validação delta: ${groups.length} grupos, esperado ${expect.missing_one_to_one}. PARAR.`);
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  for (const group of groups) {
    if (group.match_method !== "one_to_one") throw new Error("Delta contém match que não é 1:1. PARAR.");
    if (group.status !== "auto_matched") throw new Error("Delta com status diferente de auto_matched. PARAR.");
    if (group.rule_version !== OMIE_SICREDI_RULE_VERSION) throw new Error("Delta com rule_version inválida. PARAR.");
    if (group.confidence !== expect.missing_score) {
      throw new Error(`Delta score=${group.confidence}, esperado ${expect.missing_score}. PARAR.`);
    }
    if (group.score_evidence.party_match !== expect.missing_party_match) {
      throw new Error(`Delta party_match=${group.score_evidence.party_match}. PARAR.`);
    }
    if (group.score_evidence.amount_exact !== true) throw new Error("Delta sem amount_exact. PARAR.");
    if (group.score_evidence.date_distance_days !== expect.missing_date_distance_days) {
      throw new Error(`Delta date_distance=${group.score_evidence.date_distance_days}. PARAR.`);
    }
    if (group.score_evidence.candidate_count !== 1) {
      throw new Error(`Delta candidate_count=${group.score_evidence.candidate_count}. PARAR.`);
    }
    if (group.legs.length !== 2) throw new Error("Delta sem exatamente 2 legs. PARAR.");
    const omieLeg = group.legs.find((leg) => leg.role === "source");
    const bankLeg = group.legs.find((leg) => leg.role === "target");
    if (!omieLeg || !bankLeg) throw new Error("Delta sem legs source/target. PARAR.");
    const omie = byId.get(omieLeg.entry_id);
    const bank = byId.get(bankLeg.entry_id);
    if (!omie || omie.source_system !== "omie" || omie.source_kind !== "omie_receivable") {
      throw new Error("Delta sem Omie receivable. PARAR.");
    }
    if (!bank || bank.source_system !== "sicredi" || bank.source_kind !== "bank_credit") {
      throw new Error("Delta sem Sicredi bank_credit. PARAR.");
    }
    const omieAmount = omieMatchAmountCents(omie);
    const bankAmount = bankMatchAmountCents(bank);
    if (omieAmount == null || bankAmount == null || omieAmount !== bankAmount) {
      throw new Error("Delta sem valor exato Omie↔Sicredi. PARAR.");
    }
    if (omieAmount !== group.matched_amount_cents) throw new Error("Delta amount diverge do grupo. PARAR.");
    if (dateDistanceDays(omie.settlement_date, bank.settlement_date) !== 0) {
      throw new Error("Delta não é D0. PARAR.");
    }
    for (const leg of group.legs) {
      if (seen.has(leg.entry_id)) throw new Error(`Reuso de entry ${leg.entry_id} no delta. PARAR.`);
      if (existingEntryIds.has(leg.entry_id)) {
        throw new Error(`Entry ${leg.entry_id} já possui leg persistida. PARAR.`);
      }
      seen.add(leg.entry_id);
    }
    const highHits = result.groups.filter(
      (row) =>
        row.band === "high" &&
        row.kind === "one_to_one" &&
        (row.omie_entry_ids.includes(omie.id) || row.bank_entry_ids.includes(bank.id)),
    );
    if (highHits.length !== 1) {
      throw new Error(`Delta sem unique_high para ${omie.id}. PARAR.`);
    }
  }
}

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  return sqlText(JSON.stringify(value));
}

export function emitHighPersistSql(plan: HighPersistPlan): string {
  if (!plan.groups.length) throw new Error("plano high vazio");
  const groupValues = plan.groups
    .map(
      (group) =>
        `(${sqlText(group.reconciliation_key)}, ${sqlText(group.status)}, ${sqlText(group.match_method)}, ${sqlText(group.rule_version)}, ${group.confidence}, ${group.matched_amount_cents}, ${sqlJson(group.score_evidence)}::jsonb)`,
    )
    .join(",\n");
  const legValues = plan.groups
    .flatMap((group) => group.legs)
    .map(
      (leg) =>
        `(${sqlText(leg.reconciliation_key)}, ${sqlText(leg.entry_id)}::uuid, ${sqlText(leg.role)}, ${leg.allocated_amount_cents})`,
    )
    .join(",\n");

  return `begin;

create temporary table _recon_high_plan (
  reconciliation_key text primary key,
  status text not null,
  match_method text not null,
  rule_version text not null,
  confidence integer not null,
  matched_amount_cents bigint not null,
  score_evidence jsonb not null
) on commit drop;

create temporary table _recon_high_legs (
  reconciliation_key text not null,
  entry_id uuid not null,
  role text not null,
  allocated_amount_cents bigint not null
) on commit drop;

insert into _recon_high_plan (
  reconciliation_key, status, match_method, rule_version, confidence, matched_amount_cents, score_evidence
) values
${groupValues};

insert into _recon_high_legs (
  reconciliation_key, entry_id, role, allocated_amount_cents
) values
${legValues};

insert into public.financial_reconciliation_groups (
  status, match_method, rule_version, confidence, matched_amount_cents, score_evidence, reconciliation_key
)
select
  p.status, p.match_method, p.rule_version, p.confidence, p.matched_amount_cents, p.score_evidence, p.reconciliation_key
from _recon_high_plan p
where not exists (
  select 1
  from public.financial_reconciliation_groups g
  where g.reconciliation_key = p.reconciliation_key
);

insert into public.financial_reconciliation_legs (
  group_id, entry_id, role, allocated_amount_cents
)
select g.id, l.entry_id, l.role, l.allocated_amount_cents
from _recon_high_legs l
join public.financial_reconciliation_groups g on g.reconciliation_key = l.reconciliation_key
where not exists (
  select 1
  from public.financial_reconciliation_legs x
  where x.group_id = g.id and x.entry_id = l.entry_id
);

select
  (select count(*) from public.financial_reconciliation_groups where rule_version = ${sqlText(OMIE_SICREDI_RULE_VERSION)}) as groups_total,
  (select count(*) from public.financial_reconciliation_groups where rule_version = ${sqlText(OMIE_SICREDI_RULE_VERSION)} and match_method = 'one_to_one') as groups_one_to_one,
  (select count(*) from public.financial_reconciliation_groups where rule_version = ${sqlText(OMIE_SICREDI_RULE_VERSION)} and match_method = 'internal_transfer') as groups_transfer,
  (select count(*) from public.financial_reconciliation_groups where status = 'suggested') as groups_suggested,
  (select count(*) from public.financial_reconciliation_legs l
     join public.financial_reconciliation_groups g on g.id = l.group_id
    where g.rule_version = ${sqlText(OMIE_SICREDI_RULE_VERSION)}) as legs_total,
  (select count(*) from public.financial_audit_findings) as findings_total,
  (select count(*) from public.financial_reconciliation_groups g
    where not exists (select 1 from public.financial_reconciliation_legs l where l.group_id = g.id)) as orphan_groups,
  (select count(*) from (
      select entry_id from public.financial_reconciliation_legs group by entry_id having count(*) > 1
    ) d) as reused_entries;

commit;
`;
}

export function summarizeHighPersistPlan(plan: HighPersistPlan): string {
  return [
    `plano high: groups=${plan.groups.length} legs=${plan.leg_count}`,
    `1:1 ${plan.one_to_one_count} / ${plan.one_to_one_cents} cents`,
    `transfer ${plan.transfer_count} / ${plan.transfer_cents} cents`,
    `AR ${plan.ar_cents} / AP ${plan.ap_cents}`,
    `suggested/ambiguous/possible: não incluídos`,
    `findings: não persistidos`,
  ].join("\n");
}
