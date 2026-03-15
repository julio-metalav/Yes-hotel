/**
 * Script de debug: gera e exibe o plano de provisionamento de acesso
 * para uma reserva operacional (sem chamar API TTLock).
 *
 * Uso: npx tsx scripts/debug-provisioning-plan.ts
 *
 * Para inspecionar dados reais após "liberar acesso", consulte no Supabase:
 * - operacional_credenciais_acesso (por reserva_id)
 * - operacional_credencial_itens (por credencial_id)
 */

import {
  buildProvisioningPlanToPersist,
  resolveDestinationsFromFechaduras,
} from "../src/lib/application/yes-hotel";
import type { FechaduraRow } from "../src/lib/application/yes-hotel";

// Fechaduras mock para apt 07 / Bloco 1 (portão 1947) — IDs fictícios; lock_ids da migration 0003
const FECHADURAS_APT_07: FechaduraRow[] = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    identificador_externo_ttlock: "15461754",
    tipo_fechadura: "apartamento",
    apartamento_numero: "07",
    portao_identificador: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    identificador_externo_ttlock: "25709122",
    tipo_fechadura: "portao_externo",
    apartamento_numero: null,
    portao_identificador: "1947",
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    identificador_externo_ttlock: "25709168",
    tipo_fechadura: "portao_interno",
    apartamento_numero: null,
    portao_identificador: "1947",
  },
];

function main() {
  const reserva = {
    apartamento: "7",
    checkInPrevisto: "2025-03-20",
    checkOutPrevisto: "2025-03-22",
  };

  console.log("--- Plano de provisionamento (debug) ---");
  console.log("Reserva:", reserva);
  console.log("");

  const plan = buildProvisioningPlanToPersist(reserva, FECHADURAS_APT_07);
  console.log("Janela:");
  console.log("  validoDe:", plan.validoDe.toISOString());
  console.log("  validoAte:", plan.validoAte.toISOString());
  console.log("  motivoOrigem:", plan.motivoOrigem);
  console.log("");
  console.log("Destinos (lock_id real):");
  plan.destinations.forEach((d, i) => {
    console.log(
      `  ${i + 1}. ${d.codigoLogicoDestino} -> fechadura_id=${d.fechaduraId} lock_id_ttlock=${d.lockIdTtlock} (${d.tipoDestino})`,
    );
  });

  console.log("");
  console.log("--- Resolução apenas destinos (apt 12) com mock reduzido ---");
  const fechadurasApt12: FechaduraRow[] = [
    {
      id: "f-apt-12",
      identificador_externo_ttlock: "15194458",
      tipo_fechadura: "apartamento",
      apartamento_numero: "12",
      portao_identificador: null,
    },
    {
      id: "f-gate-1947-ext",
      identificador_externo_ttlock: "25709122",
      tipo_fechadura: "portao_externo",
      apartamento_numero: null,
      portao_identificador: "1947",
    },
    {
      id: "f-gate-1947-int",
      identificador_externo_ttlock: "25709168",
      tipo_fechadura: "portao_interno",
      apartamento_numero: null,
      portao_identificador: "1947",
    },
  ];
  const destinos = resolveDestinationsFromFechaduras("12", fechadurasApt12);
  console.log("Destinos para apartamento 12:", JSON.stringify(destinos, null, 2));
}

main();
