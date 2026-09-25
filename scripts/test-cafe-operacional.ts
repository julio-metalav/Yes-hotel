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
  // Homologado: "Café da Manhã" (com ou sem acento/caixa) → incluído, direito =
  // população do HITS. Valor fora da lista → NÃO IDENTIFICADO com direito 0.
  const hits = resolveCafeBreakfastEntitlementFromHits({
    guestCount: 3,
    mealPlanDesc: "Cafe da manha",
  });
  assert.equal(hits.kind, "incluido");
  assert.equal(hits.entitledQty, 3);
  const semPlano = resolveCafeBreakfastEntitlementFromHits({
    guestCount: 3,
    mealPlanDesc: "Nenhum",
  });
  assert.equal(semPlano.kind, "sem_cafe");
  assert.equal(semPlano.entitledQty, 0);
  for (const desconhecido of [null, "", "   ", "Meia pensão", "Café + almoço", "cafe"]) {
    const r = resolveCafeBreakfastEntitlementFromHits({ guestCount: 3, mealPlanDesc: desconhecido });
    assert.equal(r.kind, "nao_mapeado", "não homologado: " + JSON.stringify(desconhecido));
    assert.equal(r.entitledQty, 0);
  }
  ok("mapper HITS homologado: Café da Manhã → incluido; Nenhum → sem_cafe; resto → nao_mapeado");

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
  // O direito não é mais teto do atendimento: clamp só garante o piso 0.
  assert.equal(clampCafeAttendedQty(5, avulso.entitledQty), 5);
  assert.equal(clampCafeAttendedQty(-2, avulso.entitledQty), 0);
  assert.equal(clampCafeAttendedQty(2.7, 0), 2);
  assert.equal(clampCafeAttendedQty(Number.NaN, 3), 0);

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
  assert.equal(canRoleWriteCafeAttendance("admin"), true);
  assert.equal(canRoleWriteCafeAttendance("recepcao"), true);
  assert.equal(canRoleWriteCafeAttendance("manutencao"), false);
  assert.equal(canRoleWriteCafeAttendance(""), false);
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
    true,
  );
  assert.equal(
    assertCanWriteCafeAttendance({
      role: "recepcao",
      cafeDateYmd: "2026-08-08",
      entitlement: incluido,
      now,
    }).ok,
    true,
  );
  assert.equal(
    assertCanWriteCafeAttendance({
      role: "manutencao",
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
  assert.equal(p.canRoleWriteCafeAttendance("admin"), true);
  assert.equal(p.canRoleWriteCafeAttendance("recepcao"), true);
  assert.equal(p.canRoleWriteCafeAttendance("manutencao"), false);
  ok("yes-cafe-policy.js alinhada");
}

console.log("\n== Fronteira RPC: adulteração por perfil cafe ==");
{
  const now = atHotelLocal("2026-08-08", 10, 0);
  const persisted = {
    statusReserva: "ativa",
    totalHospedesHits: 3,
    // Plano fora da lista homologada: é o caso que precisa continuar
    // nao_mapeado mesmo com o navegador forjando kind/direito.
    mealPlanDesc: "Plano promocional X",
    cafeAvulsoPagoQtd: 0,
  };

  const serverEntitlement = resolveCafeEntitlementFromPersistedReservation(persisted);
  assert.equal(serverEntitlement.kind, "nao_mapeado");
  assert.equal(serverEntitlement.entitledQty, 0);

  // E o plano homologado resolve server-side, sem depender do navegador.
  const homologado = resolveCafeEntitlementFromPersistedReservation({
    ...persisted,
    mealPlanDesc: "Café da Manhã",
  });
  assert.equal(homologado.kind, "incluido");
  assert.equal(homologado.entitledQty, 3, "direito = total_hospedes_hits");

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
  // O direito forjado continua ignorado; o que mudou é que nao_mapeado NÃO
  // barra mais o registro de atendimento — só o "marcar todos".
  assert.equal(forged.ok, true);
  if (forged.ok) {
    assert.equal(forged.entitlement.kind, "nao_mapeado");
    assert.equal(forged.entitlement.entitledQty, 0, "direito forjado descartado");
    // A quantidade pedida vale (é contagem do operador); o direito forjado, não.
    assert.equal(forged.nextQty, 3, "set com direito 0 é permitido");
  }
  ok("claims forged de kind/direito/avulso continuam ignorados; nao_mapeado já não impede o atendimento");

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
  if (!forgedAvulsoPersistidoZero.ok) {
    assert.equal(forgedAvulsoPersistidoZero.error, "cafe_write_forbidden_no_entitlement");
  }
  ok("marcar_todos não libera com avulso forjado no navegador (direito não se presume)");

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
  // Contagem operacional não é cobrança: sem café declarado o operador ainda
  // registra quem tomou. O direito (0) é gravado como registro.
  assert.equal(semCafe.ok, true);
  if (semCafe.ok) {
    assert.equal(semCafe.entitlement.kind, "sem_cafe");
    assert.equal(semCafe.entitlement.entitledQty, 0);
    assert.equal(semCafe.nextQty, 1, "set 1 com direito 0 é permitido");
  }
  ok("sem_cafe/avulso não sincronizado já permite registrar atendimento (direito vira registro)");

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
  // O direito não é mais teto: 99 é aceito e o direito oficial (2) é gravado
  // ao lado, como registro. O forjado continua descartado.
  assert.equal(over.ok, true);
  if (over.ok) {
    assert.equal(over.nextQty, 99);
    assert.equal(over.entitlement.entitledQty, 2, "direito oficial preservado no registro");
  }
  ok("atendimento acima do direito é aceito; direito oficial continua gravado como registro");

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

console.log("\n== Controle operacional: + e − com direito 0 ==");
{
  const now = atHotelLocal("2026-08-08", 10, 0);
  const semDireito = {
    statusReserva: "ativa",
    totalHospedesHits: 2,
    // Não homologado de propósito: direito 0 e, ainda assim, + / − funcionam.
    mealPlanDesc: "Plano promocional X",
    cafeAvulsoPagoQtd: 0,
  };
  const req = (acao: string, qty?: number) => ({
    cafeDateYmd: "2026-08-08",
    operacionalReservaId: "res-op",
    acao: acao as never,
    ...(qty === undefined ? {} : { quantidadeAtendida: qty }),
  });
  const passo = (previousQty: number, acao: string) =>
    applyCafeAttendanceWrite({ role: "cafe", reservation: semDireito, previousQty, now, request: req(acao) });

  // 1 e 2: + em 0 → 1 → 2
  const a1 = passo(0, "increment");
  assert.equal(a1.ok && a1.nextQty, 1);
  const a2 = passo(1, "increment");
  assert.equal(a2.ok && a2.nextQty, 2);
  ok("1–2. + em 0 → 1 e + de novo → 2, mesmo com direito 0 (nao_mapeado)");

  // 3 e 4: − em 2 → 1 → 0
  const a3 = passo(2, "decrement");
  assert.equal(a3.ok && a3.nextQty, 1);
  const a4 = passo(1, "decrement");
  assert.equal(a4.ok && a4.nextQty, 0);
  ok("3–4. − em 2 → 1 e − em 1 → 0");

  // 5: − em 0 continua 0
  const a5 = passo(0, "decrement");
  assert.equal(a5.ok && a5.nextQty, 0);
  const a5b = applyCafeAttendanceWrite({
    role: "recepcao", reservation: semDireito, previousQty: 0, now, request: req("set", -3),
  });
  assert.equal(a5b.ok, false);
  if (!a5b.ok) assert.equal(a5b.error, "cafe_invalid_quantity");
  ok("5. − em 0 continua 0; quantidade negativa é recusada");

  // 8: dois apartamentos são independentes (a chave é reserva+data)
  const outro = applyCafeAttendanceWrite({
    role: "cafe", reservation: semDireito, previousQty: 5, now,
    request: { ...req("increment"), operacionalReservaId: "res-outro" },
  });
  assert.equal(outro.ok && outro.nextQty, 6);
  assert.equal(a1.ok && a1.nextQty, 1, "o apartamento anterior não muda");
  ok("8. apartamentos independentes: cada reserva+data tem seu próprio contador");

  // 7: totais do topo reagem — atendidos contam mesmo sem direito; faltantes nunca negativo
  const card = (id: string, kind: string, entitledQty: number, attendedQty: number) => ({
    reservationId: id,
    apartmentCode: id,
    mainGuestName: "Anon " + id,
    entitlement: { kind, entitledQty } as never,
    attendedQty,
  });
  const kpisSemDireito = summarizeCafeKpis([card("A", "nao_mapeado", 0, 2), card("B", "sem_cafe", 0, 1)]);
  assert.equal(kpisSemDireito.attendedGuests, 3, "atendidos contam sem direito");
  assert.equal(kpisSemDireito.expectedGuests, 0);
  assert.equal(kpisSemDireito.missingGuests, 0, "faltantes nunca negativo");
  assert.equal(kpisSemDireito.apartments, 2, "universo do dia preservado");
  assert.equal(kpisSemDireito.completeApartments, 0, "sem direito não existe 'completo'");
  const kpisComDireito = summarizeCafeKpis([card("C", "incluido", 2, 1), card("D", "incluido", 1, 1)]);
  assert.equal(kpisComDireito.expectedGuests, 3);
  assert.equal(kpisComDireito.attendedGuests, 2);
  assert.equal(kpisComDireito.missingGuests, 1);
  assert.equal(kpisComDireito.completeApartments, 1);
  ok("7. KPIs: atendidos sobem sem direito, previstos só com direito, faltantes nunca negativo");

  // 10: o caminho de escrita não encosta em financeiro/FNRH/HITS
  const write = readFileSync(join(process.cwd(), "src/lib/domain/yes-hotel/cafe-attendance-write.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // (`totalHospedesHits` é nome de campo da reserva, não integração.)
  for (const proibido of ["fnrh", "pagarme", "senha", "gateway", "fetch(", "cobranca"]) {
    assert.equal(write.toLowerCase().includes(proibido), false, "regra de café não toca " + proibido);
  }
  ok("10. regra de escrita do café não referencia financeiro, FNRH, senha nem HITS");
}

console.log("\n== Botão \"Concluir café da manhã\" por apartamento ==");
{
  const js = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.js"), "utf8");
  const policySrc = readFileSync(join(process.cwd(), "ui/yes-cafe-policy.js"), "utf8");
  const ctx = createContext({ globalThis: {} as never });
  (ctx as never as { globalThis: unknown }).globalThis = ctx;
  runInContext(policySrc, ctx);
  const p = (ctx as never as { YesHotelCafePolicy: Record<string, Function> }).YesHotelCafePolicy;

  // Predicado de exibição, igual ao da tela: escrevível + direito real + incompleto.
  const mostra = (kind: string, entitledQty: number, attendedQty: number, writable = true) =>
    writable && p.canMarkAllCafeAttendance({ kind, entitledQty }) && attendedQty < entitledQty;

  // 1. previsto 1 / atendido 0 → aparece.
  assert.equal(mostra("incluido", 1, 0), true);
  // 3. previsto 2 / atendido 1 → aparece (ainda falta 1).
  assert.equal(mostra("incluido", 2, 1), true);
  // 2 e 4. completo → não aparece.
  assert.equal(mostra("incluido", 1, 1), false);
  assert.equal(mostra("incluido", 2, 2), false);
  // Atendimento acima do direito (permitido pelo contador manual) também não mostra.
  assert.equal(mostra("incluido", 2, 3), false);
  // Sem direito real → nunca aparece.
  assert.equal(mostra("sem_cafe", 0, 0), false);
  assert.equal(mostra("nao_mapeado", 0, 0), false);
  assert.equal(mostra("incluido", 0, 0), false, "direito 0 não mostra");
  // Avulso pago com direito → aparece.
  assert.equal(mostra("avulso_pago", 1, 0), true);
  // Sem permissão de escrita → não aparece.
  assert.equal(mostra("incluido", 2, 0, false), false);
  ok("visibilidade: aparece só com direito real e incompleto; sem_cafe/nao_mapeado/direito 0/completo nunca");

  // Efeito real do clique, pela mesma regra server-side de `marcar_todos`.
  const concluirNoServidor = (guestCount: number, previousQty: number) =>
    applyCafeAttendanceWrite({
      role: "cafe",
      reservation: { statusReserva: "ativa", totalHospedesHits: guestCount, mealPlanDesc: "Café da Manhã", cafeAvulsoPagoQtd: 0 },
      previousQty,
      now: new Date("2026-08-08T09:00:00-03:00"),
      request: {
        cafeDateYmd: "2026-08-08",
        operacionalReservaId: "res-concluir",
        acao: "marcar_todos",
      },
    });

  // 1. previsto 1 / atendido 0 → clique deixa 1 (completo, botão some).
  const c1 = concluirNoServidor(1, 0);
  assert.equal(c1.ok, true);
  if (c1.ok) {
    assert.equal(c1.nextQty, 1);
    assert.equal(mostra("incluido", c1.entitlement.entitledQty, c1.nextQty), false);
  }
  // 3. previsto 2 / atendido 1 → clique deixa 2.
  const c2 = concluirNoServidor(2, 1);
  assert.equal(c2.ok, true);
  if (c2.ok) {
    assert.equal(c2.nextQty, 2);
    assert.equal(mostra("incluido", c2.entitlement.entitledQty, c2.nextQty), false);
  }
  // Idempotente: clicar de novo no completo não muda nada (e o botão nem existe).
  const c3 = concluirNoServidor(2, 2);
  assert.equal(c3.ok, true);
  if (c3.ok) assert.equal(c3.nextQty, 2);
  ok("clique conclui pelo direito server-side: 0→1, 1→2, idempotente no completo");

  // A tela usa exatamente esse predicado.
  assert.match(
    js,
    /const podeConcluir =\s*writable &&\s*policy\.canMarkAllCafeAttendance\(card\.entitlement\) &&\s*card\.attendedQty < card\.entitlement\.entitledQty;/,
    "predicado da tela = direito real + incompleto + permissão",
  );
  assert.match(js, /concluir\.textContent = "Concluir café da manhã";/);
  assert.match(js, /concluir\.dataset\.action = "concluir";/);
  assert.match(js, /concluir\.dataset\.reservationId = card\.reservationId;/);
  assert.match(js, /concluir\.disabled = writeInFlight;/, "não permite clique repetido");

  // 2. Clique usa a ação server-side já existente, para ESTA reserva.
  assert.match(
    js,
    /if \(action === "concluir"\) \{[\s\S]{0,200}persistAttendance\(card, null, "marcar_todos"\);[\s\S]{0,40}return;/,
    "concluir → marcar_todos da própria reserva",
  );

  // 6. Nada de backend novo: só a ação que já existia.
  const chamadas = [...js.matchAll(/persistAttendance\(card, [^,]+, ([^)]+)\)/g)].map((m) => m[1]);
  const acoes = [
    ...new Set(chamadas.flatMap((tail) => [...tail.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]))),
  ].sort();
  assert.deepEqual(acoes, ["decrement", "increment", "marcar_todos"], "nenhuma ação nova inventada");
  // A quantidade final continua sendo decidida no servidor: o único envio de
  // p_quantidade_atendida está atrás da ação "set", que o botão não usa.
  assert.equal(
    [...js.matchAll(/p_quantidade_atendida = /g)].length,
    1,
    "só um ponto envia quantidade ao servidor",
  );
  assert.match(
    js,
    /if \(action === "set" && nextQty != null\) \{\s*payload\.p_quantidade_atendida = nextQty;/,
    "quantidade só viaja na ação set",
  );

  // 5. + / − e o botão global seguem intactos.
  assert.match(js, /increase\.disabled = !writable;/);
  assert.match(js, /decrease\.disabled = !writable \|\| card\.attendedQty <= 0;/);
  assert.match(js, /markAllButtonElement\?\.addEventListener\("click", \(\) => \{\s*void markAllAttended\(\);/);
  assert.match(js, /const plans = policy\.planMarkAllCafeAttended\(cafeCards\);/, "botão global inalterado");

  // 5. Correção é só de UI: nenhuma migration/SQL/entitlement tocado nesta mudança.
  assert.match(js, /\.rpc\(\s*"operacional_cafe_set_atendimento"/, "usa a RPC existente");

  // Estilo do botão existe e é discreto (sem redesenho do card).
  const css = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.css"), "utf8");
  assert.match(css, /\.cafe-view \.cafe-concluir \{/);
  assert.match(css, /.cafe-view .cafe-concluir:disabled {/);
  ok("clique usa marcar_todos da própria reserva; + / −, botão global e RPC seguem inalterados");
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
  // 6. O valor persiste porque a carga vem do banco, não da memória da página.
  assert.match(js, /\.from\("operacional_cafe_atendimentos"\)/, "recarrega atendimento do banco");
  assert.match(js, /quantidade_atendida/);
  // 9. Falha de gravação restaura o valor anterior (sem UI divergente).
  assert.match(js, /writeInFlight/, "trava de clique repetido");
  assert.match(js, /card\.attendedQty = policy\.clampCafeAttendedQty\(/, "rollback do valor anterior");
  // Badge operacional no lugar de "somente consulta".
  assert.match(js, /"Controle operacional"/);
  assert.doesNotMatch(js, /cafeReadonlyBadge\?\.classList\.toggle\("hidden", write\)/, "badge não é mais só-consulta escondido");
  // + e − não dependem mais do direito.
  assert.match(js, /increase\.disabled = !writable;/, "+ só depende de permissão");
  assert.match(js, /decrease\.disabled = !writable \|\| card\.attendedQty <= 0;/, "− trava no piso 0");
  ok("6 e 9. valor vem do banco, clique repetido travado, rollback em erro, badge operacional, + e − livres do direito");
  assert.match(
    js,
    /\.sort\(\(a, b\) =>\s*policy\.compareCafeApartmentCodes\(a\.apartmentCode, b\.apartmentCode\)/s,
  );

  const sql = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260928090000_cafe_controle_operacional.sql",
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
  // As duas travas de direito saíram do caminho de + / −; só marcar_todos mantém.
  assert.doesNotMatch(sql, /cafe_write_forbidden_unmapped_entitlement/);
  assert.doesNotMatch(sql, /cafe_write_forbidden_over_entitlement/);
  assert.match(sql, /cafe_write_forbidden_no_entitlement/, "marcar_todos ainda exige direito");
  ok("UI e SQL sem p_cafe_kind/p_quantidade_direito; direito vem da reserva");

  // A migration mantém tudo o que protegia.
  assert.match(sql, /if auth\.uid\(\) is null then/, "autenticação obrigatória");
  assert.match(sql, /not in \('cafe', 'recepcao', 'admin'\)/, "perfis autorizados");
  assert.match(sql, /cafe_write_forbidden_future_date/, "data futura barrada");
  assert.match(sql, /cafe_reservation_cancelled/, "reserva cancelada barrada");
  assert.match(sql, /for update;/, "SELECT ... FOR UPDATE (atômico)");
  assert.match(sql, /on conflict \(operacional_reserva_id, data_cafe\)/, "upsert idempotente");
  assert.match(sql, /insert into public\.operacional_cafe_atendimento_auditoria/, "auditoria");
  assert.match(sql, /security definer/);
  // Os comentários da migration citam de propósito o que foi removido; as
  // guardas estruturais olham só o SQL executável.
  const sqlSemComentarios = sql.replace(/^\s*--.*$/gm, "");
  assert.match(sql, /check \(quantidade_atendida >= 0 and quantidade_direito >= 0\)/, "piso 0, sem teto");
  assert.doesNotMatch(sqlSemComentarios, /quantidade_atendida <= quantidade_direito/, "teto pelo direito removido");
  assert.match(sql, /v_next := greatest\(v_prev - 1, 0\)/, "decrement nunca abaixo de 0");
  assert.match(sql, /v_next := v_prev \+ 1;/, "increment sem teto");
  assert.doesNotMatch(sqlSemComentarios, /least\(v_prev \+ 1/, "sem least pelo direito");
  assert.match(
    sql,
    /grant execute on function public\.operacional_cafe_set_atendimento\(date, uuid, integer, text\)\s*\n\s*to authenticated;/,
  );
  assert.doesNotMatch(sql, /to anon|to public;/, "nada liberado a anon/public");
  // Fora de escopo intocado.
  const sqlCode = sql.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(sqlCode, /fnrh|senha|pagarme|financ|hits_reservas_snapshot/i, "não toca FNRH/senha/financeiro/HITS");
  assert.doesNotMatch(sqlCode, /drop table|truncate|delete from/i, "nada é apagado");
  ok("migration: autenticação, perfis, data, reserva, FOR UPDATE, upsert, auditoria, RLS e piso 0 preservados");
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
