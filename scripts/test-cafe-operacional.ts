/**
 * Testes essenciais do Café operacional (domínio puro + policy browser).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";

import {
  addDaysYmd,
  canRegisterCafeAttendanceForDate,
  formatCafeDateBr,
  hotelTodayYmd,
  resolveCafeDateHeader,
  resolveCafeOperationalDateYmd,
  resolveSelectedCafeDateYmd,
} from "../src/lib/domain/yes-hotel/cafe-operational-date.ts";
import {
  compareCafeApartmentCodes,
  isCafeStayOnDate,
  selectCafeStaysForDate,
} from "../src/lib/domain/yes-hotel/cafe-stay-selection.ts";
import {
  buildCafeBreakfastEntitlement,
  resolveCafeBreakfastEntitlementFromHits,
} from "../src/lib/domain/yes-hotel/cafe-breakfast-entitlement.ts";
import {
  assertCanWriteCafeAttendance,
  canRoleWriteCafeAttendance,
  clampCafeAttendedQty,
  planMarkAllCafeAttended,
  summarizeCafeKpis,
} from "../src/lib/domain/yes-hotel/cafe-attendance-policy.ts";
import {
  applyCafeAttendanceWrite,
  resolveCafeEntitlementFromPersistedReservation,
} from "../src/lib/domain/yes-hotel/cafe-attendance-write.ts";
import { isValidCafeStayStatus } from "../src/lib/domain/yes-hotel/cafe-stay-selection.ts";

function ok(label: string) {
  console.log(`  OK  ${label}`);
}

function atHotelLocal(ymd: string, hour: number, minute = 0): Date {
  // America/Campo_Grande = UTC-4 ⇒ UTC = local + 4h
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour + 4, minute, 0));
}

console.log("\n== Data operacional ==");
{
  const d1159 = atHotelLocal("2026-08-08", 11, 59);
  const d1200 = atHotelLocal("2026-08-08", 12, 0);
  assert.equal(resolveCafeOperationalDateYmd(d1159), "2026-08-08");
  assert.equal(resolveCafeOperationalDateYmd(d1200), "2026-08-09");
  assert.equal(hotelTodayYmd(d1200), "2026-08-08");
  ok("11:59 → mesmo dia; 12:00 → dia seguinte");
}
{
  const now = atHotelLocal("2026-08-08", 15, 0);
  assert.equal(
    resolveSelectedCafeDateYmd({ mode: "auto", manualYmd: null, now }),
    "2026-08-09",
  );
  assert.equal(
    resolveSelectedCafeDateYmd({
      mode: "manual",
      manualYmd: "2026-08-07",
      now,
    }),
    "2026-08-07",
  );
  const headerAuto = resolveCafeDateHeader("2026-08-09", now);
  assert.equal(headerAuto.kind, "amanha");
  assert.match(headerAuto.label, /Café de amanhã/);
  const headerConsulta = resolveCafeDateHeader("2026-08-01", now);
  assert.equal(headerConsulta.kind, "consulta");
  assert.equal(formatCafeDateBr("2026-08-09"), "09/08/2026");
  ok("seleção manual não muda; header e format BR");
}
{
  const now = atHotelLocal("2026-08-08", 10, 0);
  assert.equal(canRegisterCafeAttendanceForDate("2026-08-08", now), true);
  assert.equal(canRegisterCafeAttendanceForDate("2026-08-09", now), false);
  ok("data futura bloqueada para alteração");
}

console.log("\n== Estadias do café ==");
{
  const rows = [
    {
      id: "r10",
      externalReservationId: "H10",
      apartmentCode: "10",
      mainGuestName: "A",
      checkInYmd: "2026-08-07",
      checkOutYmd: "2026-08-10",
      statusReserva: "ativa",
      totalGuests: 2,
      mealPlanDesc: "Cafe da manha",
    },
    {
      id: "r02",
      externalReservationId: "H02",
      apartmentCode: "02",
      mainGuestName: "B",
      checkInYmd: "2026-08-07",
      checkOutYmd: "2026-08-08",
      statusReserva: "ativa",
      totalGuests: 1,
      mealPlanDesc: null,
    },
    {
      id: "r11",
      externalReservationId: "H11",
      apartmentCode: "11",
      mainGuestName: "C",
      checkInYmd: "2026-08-08",
      checkOutYmd: "2026-08-12",
      statusReserva: "ativa",
      totalGuests: 3,
      mealPlanDesc: null,
    },
    {
      id: "r01",
      externalReservationId: "H01",
      apartmentCode: "01",
      mainGuestName: "D",
      checkInYmd: "2026-08-06",
      checkOutYmd: "2026-08-09",
      statusReserva: "cancelada",
      totalGuests: 2,
      mealPlanDesc: null,
    },
  ];
  assert.equal(isCafeStayOnDate(rows[0]!, "2026-08-08"), true);
  assert.equal(isCafeStayOnDate(rows[2]!, "2026-08-08"), false); // check-in no próprio dia
  const selected = selectCafeStaysForDate(rows, "2026-08-08");
  assert.deepEqual(
    selected.map((r) => r.apartmentCode),
    ["02", "10"],
  );
  assert.deepEqual(
    ["10", "02", "11", "01"].sort(compareCafeApartmentCodes),
    ["01", "02", "10", "11"],
  );
  assert.deepEqual(
    ["27", "30", "31", "28", "29"].sort(compareCafeApartmentCodes),
    ["27", "28", "29", "30", "31"],
  );
  ok("janela cin < D <= cout; cancelada fora; ordem numérica crescente");
  assert.equal(isValidCafeStayStatus("4"), false);
  assert.equal(isValidCafeStayStatus("blocked"), false);
  assert.equal(isValidCafeStayStatus("Blocked"), false);
  assert.equal(isValidCafeStayStatus("ativa"), true);
  ok("status 4/Blocked fora da seleção do café");
}

console.log("\n== Entitlement / KPIs / mark-all ==");
{
  const hits = resolveCafeBreakfastEntitlementFromHits({
    guestCount: 3,
    mealPlanDesc: "Cafe da manha",
  });
  assert.equal(hits.kind, "nao_mapeado");
  assert.equal(hits.entitledQty, 0);
  ok("mapper HITS atual retorna nao_mapeado (sem inventar)");

  const incluido = buildCafeBreakfastEntitlement({
    kind: "incluido",
    guestCount: 3,
  });
  const sem = buildCafeBreakfastEntitlement({ kind: "sem_cafe", guestCount: 3 });
  const avulso = buildCafeBreakfastEntitlement({
    kind: "avulso_pago",
    guestCount: 3,
    paidExtraQty: 1,
  });
  assert.equal(incluido.entitledQty, 3);
  assert.equal(sem.entitledQty, 0);
  assert.equal(avulso.entitledQty, 1);
  assert.equal(clampCafeAttendedQty(5, avulso.entitledQty), 1);

  const cards = [
    {
      reservationId: "a",
      apartmentCode: "01",
      mainGuestName: "Anon A",
      entitlement: incluido,
      attendedQty: 1,
    },
    {
      reservationId: "b",
      apartmentCode: "02",
      mainGuestName: "Anon B",
      entitlement: sem,
      attendedQty: 0,
    },
    {
      reservationId: "c",
      apartmentCode: "10",
      mainGuestName: "Anon C",
      entitlement: avulso,
      attendedQty: 0,
    },
  ];
  const kpis = summarizeCafeKpis(cards);
  assert.equal(kpis.apartments, 3);
  assert.equal(kpis.expectedGuests, 4); // 3 incluidos + 1 avulso
  assert.equal(kpis.attendedGuests, 1);
  assert.equal(kpis.missingGuests, 3);

  const plans = planMarkAllCafeAttended(cards);
  assert.deepEqual(
    plans.map((p) => p.reservationId),
    ["a", "c"],
  );
  for (const plan of plans) {
    assert.equal("nextQty" in plan, false);
    assert.equal("previousQty" in plan, false);
  }
  ok("incluido/sem/avulso; mark-all só IDs (sem direito/limite do navegador)");
}

console.log("\n== Permissões ==");
{
  const incluido = buildCafeBreakfastEntitlement({
    kind: "incluido",
    guestCount: 2,
  });
  const now = atHotelLocal("2026-08-08", 10, 0);
  assert.equal(canRoleWriteCafeAttendance("cafe"), true);
  assert.equal(canRoleWriteCafeAttendance("admin"), false);
  assert.equal(canRoleWriteCafeAttendance("recepcao"), false);
  assert.equal(
    assertCanWriteCafeAttendance({
      role: "cafe",
      cafeDateYmd: "2026-08-08",
      entitlement: incluido,
      now,
    }).ok,
    true,
  );
  assert.equal(
    assertCanWriteCafeAttendance({
      role: "admin",
      cafeDateYmd: "2026-08-08",
      entitlement: incluido,
      now,
    }).ok,
    false,
  );
  assert.equal(
    assertCanWriteCafeAttendance({
      role: "recepcao",
      cafeDateYmd: "2026-08-08",
      entitlement: incluido,
      now,
    }).ok,
    false,
  );
  assert.equal(
    assertCanWriteCafeAttendance({
      role: "cafe",
      cafeDateYmd: "2026-08-09",
      entitlement: incluido,
      now,
    }).ok,
    false,
  );
  ok("somente perfil cafe grava; admin/recepção e data futura bloqueados");
}

console.log("\n== Policy browser espelhada ==");
{
  const source = readFileSync(
    join(process.cwd(), "ui/yes-cafe-policy.js"),
    "utf8",
  );
  const ctx = createContext({ globalThis: {} as any, window: undefined });
  (ctx as any).globalThis = ctx;
  runInContext(source, ctx);
  const p = (ctx as any).YesHotelCafePolicy;
  const now = atHotelLocal("2026-08-08", 12, 0);
  assert.equal(p.resolveCafeOperationalDateYmd(now), "2026-08-09");
  assert.equal(p.canRoleWriteCafeAttendance("cafe"), true);
  assert.equal(p.canRoleWriteCafeAttendance("admin"), false);
  ok("yes-cafe-policy.js alinhada");
}

console.log("\n== Fronteira RPC: adulteração por perfil cafe ==");
{
  const now = atHotelLocal("2026-08-08", 10, 0);
  const persisted = {
    statusReserva: "ativa",
    totalHospedesHits: 3,
    mealPlanDesc: "Cafe da manha",
    cafeAvulsoPagoQtd: 0,
  };

  const serverEntitlement = resolveCafeEntitlementFromPersistedReservation(persisted);
  assert.equal(serverEntitlement.kind, "nao_mapeado");
  assert.equal(serverEntitlement.entitledQty, 0);

  // Perfil cafe autenticado tenta forjar kind + direito + avulso + qty.
  const forged = applyCafeAttendanceWrite({
    role: "cafe",
    reservation: persisted,
    previousQty: 0,
    now,
    request: {
      cafeDateYmd: "2026-08-08",
      operacionalReservaId: "res-1",
      quantidadeAtendida: 3,
      acao: "set",
      forgedCafeKind: "incluido",
      forgedQuantidadeDireito: 3,
      forgedAvulsoPago: 2,
    },
  });
  assert.equal(forged.ok, false);
  if (!forged.ok) {
    assert.equal(forged.error, "cafe_write_forbidden_unmapped_entitlement");
  }
  ok("claims forged de kind/direito/avulso são ignorados; nao_mapeado rejeita");

  // Mesmo com avulso “inventado” só no request (persistido = 0).
  const forgedAvulsoPersistidoZero = applyCafeAttendanceWrite({
    role: "cafe",
    reservation: { ...persisted, cafeAvulsoPagoQtd: 0 },
    previousQty: 0,
    now,
    request: {
      cafeDateYmd: "2026-08-08",
      operacionalReservaId: "res-1",
      acao: "marcar_todos",
      forgedCafeKind: "avulso_pago",
      forgedAvulsoPago: 5,
      forgedQuantidadeDireito: 5,
    },
  });
  assert.equal(forgedAvulsoPersistidoZero.ok, false);
  ok("marcar_todos não libera com avulso forjado no navegador");

  // Sem café persistido sem avulso oficial → rejeita.
  const semCafe = applyCafeAttendanceWrite({
    role: "cafe",
    reservation: persisted,
    previousQty: 0,
    now,
    serverEntitlementOverride: buildCafeBreakfastEntitlement({
      kind: "sem_cafe",
      guestCount: 3,
    }),
    request: {
      cafeDateYmd: "2026-08-08",
      operacionalReservaId: "res-1",
      quantidadeAtendida: 1,
      acao: "set",
      forgedCafeKind: "avulso_pago",
      forgedAvulsoPago: 1,
    },
  });
  assert.equal(semCafe.ok, false);
  if (!semCafe.ok) {
    assert.equal(semCafe.error, "cafe_write_forbidden_no_entitlement");
  }
  ok("sem_cafe sem avulso oficial sincronizado rejeita atendimento");

  // Direito oficial server-side (simula futura homologação) vs qty adulterada.
  const over = applyCafeAttendanceWrite({
    role: "cafe",
    reservation: persisted,
    previousQty: 0,
    now,
    serverEntitlementOverride: buildCafeBreakfastEntitlement({
      kind: "incluido",
      guestCount: 2,
    }),
    request: {
      cafeDateYmd: "2026-08-08",
      operacionalReservaId: "res-1",
      quantidadeAtendida: 99,
      acao: "set",
      forgedQuantidadeDireito: 99,
      forgedCafeKind: "incluido",
    },
  });
  assert.equal(over.ok, false);
  if (!over.ok) {
    assert.equal(over.error, "cafe_write_forbidden_over_entitlement");
  }
  ok("atendimento acima do direito oficial é rejeitado");

  const markAllServer = applyCafeAttendanceWrite({
    role: "cafe",
    reservation: persisted,
    previousQty: 0,
    now,
    serverEntitlementOverride: buildCafeBreakfastEntitlement({
      kind: "incluido",
      guestCount: 2,
    }),
    request: {
      cafeDateYmd: "2026-08-08",
      operacionalReservaId: "res-1",
      // Navegador tenta mandar qty menor/maior — marcar_todos ignora e usa teto server.
      quantidadeAtendida: 99,
      acao: "marcar_todos",
      forgedQuantidadeDireito: 99,
    },
  });
  assert.equal(markAllServer.ok, true);
  if (markAllServer.ok) {
    assert.equal(markAllServer.nextQty, 2);
    assert.equal(markAllServer.entitlement.entitledQty, 2);
  }
  ok("marcar_todos usa teto server-side, não quantidade do navegador");
}

console.log("\n== Contrato UI/SQL sem parâmetros inseguros ==");
{
  const js = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.js"), "utf8");
  assert.equal(js.includes("p_quantidade_direito"), false);
  assert.equal(js.includes("p_cafe_kind"), false);
  assert.match(js, /p_operacional_reserva_id/);
  assert.match(js, /p_data_cafe/);
  assert.match(js, /p_acao:\s*action/);
  assert.match(js, /"marcar_todos"/);
  assert.doesNotMatch(js, /const aPpd\s*=/);
  assert.match(
    js,
    /\.sort\(\(a, b\) =>\s*policy\.compareCafeApartmentCodes\(a\.apartmentCode, b\.apartmentCode\)/s,
  );

  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260809005734_operacional_cafe_atendimento.sql",
    ),
    "utf8",
  );
  assert.match(sql, /operacional_cafe_resolve_entitlement/);
  assert.match(
    sql,
    /create or replace function public\.operacional_cafe_set_atendimento\(\s*p_data_cafe date,\s*p_operacional_reserva_id uuid,\s*p_quantidade_atendida integer default null,\s*p_acao text default 'set'\s*\)/s,
  );
  assert.equal(/p_cafe_kind\s+text/.test(sql), false);
  assert.equal(/p_quantidade_direito\s+integer/.test(sql), false);
  assert.match(sql, /v_reserva\.meal_plan_desc/);
  assert.match(sql, /v_reserva\.total_hospedes_hits/);
  assert.match(sql, /v_reserva\.cafe_avulso_pago_qtd/);
  assert.match(sql, /cafe_write_forbidden_unmapped_entitlement/);
  assert.match(sql, /cafe_write_forbidden_over_entitlement/);
  ok("UI e SQL sem p_cafe_kind/p_quantidade_direito; direito vem da reserva");
}

console.log("\n== Ausência de mocks no runtime UI ==");
{
  const js = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.js"), "utf8");
  assert.equal(js.includes("const breakfastCards = ["), false);
  assert.match(js, /operacional_reservas/);
  assert.match(js, /operacional_cafe_set_atendimento/);
  assert.match(js, /__YES_CAFE_TEST_DATASET__/);
  ok("mocks estáticos removidos; carga real + seam de teste");
}

console.log("\nTodos os testes essenciais do café passaram.\n");
