/**
 * Motor de alertas gerenciais determinístico (sem IA).
 * Compara métricas atuais vs limiares; a UI/persistência virá depois.
 */

export type ManagementAlertCode =
  | "future_occupancy_below_history"
  | "adr_drop"
  | "cancellations_up"
  | "direct_reservations_down"
  | "ota_share_excessive"
  | "overdue_receivables"
  | "b2b_company_drop"
  | "high_value_guest_inactive";

export type ManagementAlert = {
  code: ManagementAlertCode;
  severity: "info" | "warning" | "critical";
  message: string;
};

export type ManagementAlertInput = {
  futureOccupancy: number | null;
  historicalOccupancy: number | null;
  currentAdrCents: number | null;
  previousAdrCents: number | null;
  currentCancelRate: number | null;
  previousCancelRate: number | null;
  currentDirectShare: number | null;
  previousDirectShare: number | null;
  otaShare: number | null;
  overdueCents: number;
  b2bRevenueDeltaRatio: number | null;
  highValueInactiveCount: number;
};

export type ManagementAlertThresholds = {
  occupancyGap: number;
  adrDropRatio: number;
  cancelRateIncrease: number;
  directShareDrop: number;
  otaShareMax: number;
  overdueCents: number;
  b2bDropRatio: number;
};

export const DEFAULT_ALERT_THRESHOLDS: ManagementAlertThresholds = {
  occupancyGap: 0.1,
  adrDropRatio: 0.08,
  cancelRateIncrease: 0.05,
  directShareDrop: 0.08,
  otaShareMax: 0.7,
  overdueCents: 1,
  b2bDropRatio: 0.25,
};

export function evaluateManagementAlerts(
  input: ManagementAlertInput,
  thresholds: ManagementAlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): ManagementAlert[] {
  const alerts: ManagementAlert[] = [];

  if (
    input.futureOccupancy != null &&
    input.historicalOccupancy != null &&
    input.historicalOccupancy - input.futureOccupancy >= thresholds.occupancyGap
  ) {
    alerts.push({
      code: "future_occupancy_below_history",
      severity: "warning",
      message: "Ocupação futura abaixo da média histórica.",
    });
  }

  if (
    input.currentAdrCents != null &&
    input.previousAdrCents != null &&
    input.previousAdrCents > 0 &&
    (input.previousAdrCents - input.currentAdrCents) / input.previousAdrCents >=
      thresholds.adrDropRatio
  ) {
    alerts.push({
      code: "adr_drop",
      severity: "warning",
      message: "Queda de ADR acima do limiar.",
    });
  }

  if (
    input.currentCancelRate != null &&
    input.previousCancelRate != null &&
    input.currentCancelRate - input.previousCancelRate >= thresholds.cancelRateIncrease
  ) {
    alerts.push({
      code: "cancellations_up",
      severity: "warning",
      message: "Aumento de cancelamentos acima do limiar.",
    });
  }

  if (
    input.currentDirectShare != null &&
    input.previousDirectShare != null &&
    input.previousDirectShare - input.currentDirectShare >= thresholds.directShareDrop
  ) {
    alerts.push({
      code: "direct_reservations_down",
      severity: "warning",
      message: "Queda de participação de reservas diretas.",
    });
  }

  if (input.otaShare != null && input.otaShare > thresholds.otaShareMax) {
    alerts.push({
      code: "ota_share_excessive",
      severity: "warning",
      message: "Participação OTA acima do limiar.",
    });
  }

  if (input.overdueCents >= thresholds.overdueCents) {
    alerts.push({
      code: "overdue_receivables",
      severity: input.overdueCents >= 100_000 ? "critical" : "warning",
      message: "Há contas a receber vencidas.",
    });
  }

  if (
    input.b2bRevenueDeltaRatio != null &&
    input.b2bRevenueDeltaRatio <= -thresholds.b2bDropRatio
  ) {
    alerts.push({
      code: "b2b_company_drop",
      severity: "warning",
      message: "Queda relevante de receita B2B.",
    });
  }

  if (input.highValueInactiveCount > 0) {
    alerts.push({
      code: "high_value_guest_inactive",
      severity: "info",
      message: "Há hóspede/empresa de alto valor sem retorno recente.",
    });
  }

  return alerts;
}
