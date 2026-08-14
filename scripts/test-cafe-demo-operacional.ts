/**
 * Café demo A–N: entitlements, estados PPD e isolamento de produção.
 * Sem navegador, rede ou banco.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import {
  buildCafeBreakfastEntitlement,
  resolveCafeBreakfastEntitlementFromHits,
} from "../src/lib/domain/yes-hotel/cafe-breakfast-entitlement.ts";
import {
  cafeOperationalStatusLabel,
  clampCafeAttendedQty,
  summarizeCafeKpis,
} from "../src/lib/domain/yes-hotel/cafe-attendance-policy.ts";
import {
  buildCafePpdAlertView,
  resolveCafePpdOperationalState,
  resolvePpdChargeAmount,
  shouldShowCafePpdAlert,
} from "../src/lib/domain/yes-hotel/cafe-ppd-alert.ts";

function ok(label: string) {
  console.log(`  OK  ${label}`);
}

function loadBrowserModules() {
  const ctx = createContext({ globalThis: {} as Record<string, unknown> });
  (ctx as unknown as { globalThis: unknown }).globalThis = ctx;
  runInContext(readFileSync(join(process.cwd(), "ui/yes-cafe-policy.js"), "utf8"), ctx);
  runInContext(readFileSync(join(process.cwd(), "ui/cafe-demo-data.js"), "utf8"), ctx);
  return {
    policy: (ctx as unknown as { YesHotelCafePolicy: Record<string, Function> })
      .YesHotelCafePolicy,
    demo: (ctx as unknown as { YesHotelCafeDemo: { createDataset: Function } })
      .YesHotelCafeDemo,
  };
}

console.log("\n== A–D) Entitlements ==");
const incluido = buildCafeBreakfastEntitlement({ kind: "incluido", guestCount: 2 });
const semCafe = buildCafeBreakfastEntitlement({ kind: "sem_cafe", guestCount: 2 });
const avulso = buildCafeBreakfastEntitlement({
  kind: "avulso_pago",
  guestCount: 2,
  paidExtraQty: 1,
});
const naoMapeado = resolveCafeBreakfastEntitlementFromHits({
  guestCount: 1,
  mealPlanDesc: "Cafe da manha",
});
assert.equal(incluido.entitledQty, 2);
assert.equal(semCafe.entitledQty, 0);
assert.equal(avulso.entitledQty, 1);
assert.equal(naoMapeado.kind, "nao_mapeado");
assert.equal(naoMapeado.entitledQty, 0);
ok("incluido=guestCount; sem_cafe=0; avulso=qtd paga; nao_mapeado=0");

console.log("\n== E–H) Estados PPD ==");
const basePpd = {
  ppdEfetivado: true,
  pagamentoStatus: "pendente",
  statusReserva: "ativa",
  ppdDeadlineEm: "2026-08-14T09:00:00-04:00",
};
const charge = resolvePpdChargeAmount({ operacionalValorTotal: 250 });
const pendingState = resolveCafePpdOperationalState({
  ...basePpd,
  nowIso: "2026-08-14T08:15:00-04:00",
});
const overdueState = resolveCafePpdOperationalState({
  ...basePpd,
  nowIso: "2026-08-14T09:00:00-04:00",
});
const suspendedState = resolveCafePpdOperationalState({
  ...basePpd,
  nowIso: "2026-08-14T09:01:00-04:00",
  ppdBloqueadoEm: "2026-08-14T09:01:00-04:00",
});
const regularizedState = resolveCafePpdOperationalState({
  ...basePpd,
  pagamentoStatus: "pago",
  ppdRegularizadoEm: "2026-08-14T08:45:00-04:00",
  nowIso: "2026-08-14T08:46:00-04:00",
});
assert.equal(pendingState, "pending");
assert.equal(overdueState, "overdue");
assert.equal(suspendedState, "suspended");
assert.equal(regularizedState, "regularized");

const pendingView = buildCafePpdAlertView({
  charge,
  state: pendingState,
});
assert.equal(
  pendingView.badgeLabel.replace(/\s/g, " "),
  "DIÁRIA PENDENTE: R$ 250,00",
);
const missingValueView = buildCafePpdAlertView({
  charge: resolvePpdChargeAmount({}),
  state: pendingState,
});
assert.equal(missingValueView.badgeLabel, "DIÁRIA PENDENTE");
const overdueView = buildCafePpdAlertView({
  charge,
  state: overdueState,
});
assert.equal(overdueView.badgeLabel, pendingView.badgeLabel);
const suspendedView = buildCafePpdAlertView({
  charge,
  state: suspendedState,
});
assert.equal(suspendedView.badgeLabel, pendingView.badgeLabel);
assert.doesNotMatch(
  JSON.stringify([pendingView, overdueView, suspendedView]),
  /09:00|suspens|TTLock|HITS|tolerância|cron|gateway|API/i,
);
assert.equal(
  shouldShowCafePpdAlert({
    ...basePpd,
    ppdRegularizadoEm: "2026-08-14T08:45:00-04:00",
  }),
  false,
);
assert.equal(
  shouldShowCafePpdAlert({
    ...basePpd,
    pagamentoStatus: "pago",
  }),
  false,
);
ok("PPD aplicável tem copy única; regularizado/pago não exibe alerta");

console.log("\n== I–J) PPD independente do café + limites ==");
assert.equal(incluido.entitledQty, 2);
assert.equal(
  buildCafeBreakfastEntitlement({ kind: "incluido", guestCount: 2 }).entitledQty,
  2,
);
assert.equal(clampCafeAttendedQty(99, avulso.entitledQty), 1);
assert.equal(clampCafeAttendedQty(-1, incluido.entitledQty), 0);
assert.equal(cafeOperationalStatusLabel(semCafe, 0), "Sem café");
assert.equal(cafeOperationalStatusLabel(naoMapeado, 0), "Café ainda não identificado");
ok("PPD não muda entitledQty; +/- respeita 0..entitledQty");

console.log("\n== Demo A–H e KPIs ==");
const { policy, demo } = loadBrowserModules();
const rows = demo.createDataset("2026-08-14") as Array<Record<string, unknown>>;
assert.equal(rows.length, 8);
assert.deepEqual(
  Array.from(rows, (row) => row.scenario).sort(),
  ["A", "B", "C", "D", "E", "F", "G", "H"],
);
const cards = rows.map((row) => {
  const kind = String(row.kind);
  const entitlement =
    kind === "nao_mapeado"
      ? policy.resolveCafeBreakfastEntitlementFromHits({
          guestCount: row.totalGuests,
        })
      : policy.buildCafeBreakfastEntitlement({
          kind,
          guestCount: row.totalGuests,
          paidExtraQty: row.paidExtraQty || 0,
        });
  return {
    reservationId: String(row.id),
    apartmentCode: String(row.apartmentCode),
    mainGuestName: String(row.mainGuestName),
    entitlement,
    attendedQty: Number(row.attendedQty) || 0,
  };
});
const byApartment = new Map(cards.map((card) => [card.apartmentCode, card]));
assert.equal(policy.cafeGuestLine(byApartment.get("34")!.entitlement), "1 hóspede · Café incluído");
assert.equal(policy.cafeStatusLabel(byApartment.get("34")!.entitlement), "Incluído na diária");
assert.equal(policy.cafeGuestLine(byApartment.get("33")!.entitlement), "2 hóspedes · Sem café incluído");
assert.equal(policy.cafeOperationalStatusLabel(byApartment.get("33")!.entitlement, 0), "Sem café");
assert.equal(byApartment.get("32")!.entitlement.entitledQty, 1);
assert.equal(policy.cafeStatusLabel(byApartment.get("32")!.entitlement), "1 café avulso pago");
assert.equal(
  policy.cafeOperationalStatusLabel(byApartment.get("28")!.entitlement, 0),
  "Café ainda não identificado",
);
const ppdRows = new Map(rows.map((row) => [row.scenario, row]));
assert.equal(
  policy.resolveCafePpdOperationalState({
    ppdEfetivado: true,
    pagamentoStatus: "pendente",
    statusReserva: "ativa",
    ppdDeadlineEm: ppdRows.get("D")!.ppdDeadlineEm,
    nowIso: ppdRows.get("D")!.demoNowIso,
  }),
  "pending",
);
assert.equal(
  policy.resolveCafePpdOperationalState({
    ppdEfetivado: true,
    pagamentoStatus: "pendente",
    statusReserva: "ativa",
    ppdDeadlineEm: ppdRows.get("E")!.ppdDeadlineEm,
    nowIso: ppdRows.get("E")!.demoNowIso,
  }),
  "overdue",
);
const kpis = summarizeCafeKpis(cards);
assert.deepEqual(kpis, {
  apartments: 8,
  expectedGuests: 8,
  attendedGuests: 0,
  missingGuests: 8,
  completeApartments: 0,
});
ok("8 cards; Cafés previstos=8; atendidos=0; faltantes=8; apartamentos=8");

console.log("\n== K–M) Isolamento e produção ==");
const uiSource = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.js"), "utf8");
const demoSource = readFileSync(join(process.cwd(), "ui/cafe-demo-data.js"), "utf8");
const html = readFileSync(join(process.cwd(), "ui/cafe-da-manha-mvp.html"), "utf8");
const loginHtml = readFileSync(join(process.cwd(), "ui/usuarios-login-mvp.html"), "utf8");
const loginJs = readFileSync(join(process.cwd(), "ui/usuarios-login-mvp.js"), "utf8");
const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260809005734_operacional_cafe_atendimento.sql",
  ),
  "utf8",
);
assert.doesNotMatch(
  demoSource,
  /operacional_reservas|operacional_cafe_atendimentos|rpc\(|fetch\(|TTLock|DigiSac|WhatsApp/i,
);
assert.match(uiSource, /demoMode/);
assert.match(uiSource, /new URLSearchParams\(window\.location\.search\).*demo/s);
assert.match(uiSource, /if \(demoMode\) \{[\s\S]*card\.attendedQty = localNext;[\s\S]*return;/);
assert.match(html, /MODO DEMONSTRAÇÃO/);
assert.match(html, /Cafés previstos/);
assert.match(html, />Com café</);
assert.match(html, />Sem café \/ não identificado</);
assert.doesNotMatch(html, />Não pagos</);
assert.doesNotMatch(html, /src="\.\/cafe-demo-data\.js/);
assert.ok(
  uiSource.indexOf("canAccessBreakfast(currentUser)") <
    uiSource.indexOf("await ensureDemoModuleLoaded()"),
);
assert.match(uiSource, /script\.src = "\.\/cafe-demo-data\.js\?v=2"/);
assert.match(html, /cafe-da-manha-mvp\.js\?v=9/);
assert.match(html, /yes-cafe-policy\.js\?v=4/);
assert.match(html, /cafe-da-manha-mvp\.css\?v=8/);
assert.match(uiSource, /usuarios-login-mvp\.html\?next=cafe-demo/);
assert.match(loginJs, /get\("next"\) === "cafe-demo"/);
assert.match(loginJs, /cafe-da-manha-mvp\.html\?demo=1/);
assert.match(loginHtml, /usuarios-login-mvp\.js\?v=7/);
assert.match(uiSource, /const localDataset = demoMode \? demoDataset : testDataset/);
assert.equal(resolveCafeBreakfastEntitlementFromHits({ guestCount: 2 }).kind, "nao_mapeado");
assert.match(sql, /cafe_kind := 'nao_mapeado';\s*quantidade_direito := 0;/);
assert.match(sql, /NÃO interpretar texto de meal_plan_desc/);
ok("?demo=1 explícito e em memória; produção/HITS continuam nao_mapeado");

console.log("\nOK test-cafe-demo-operacional (A–N)\n");
