/**
 * Ponte do ciclo HITS para o lifecycle TTLock.
 * A Edge de preview não fala com a fechadura; quem revoga e provisiona
 * continua sendo yes-hotel-lifecycle / handleRoomChange.
 */

import type { AplicarTrocaApartamento } from "./hits-room-change.ts";

function envValue(name: string): string {
  const deno = (globalThis as { Deno?: { env?: { get?: (key: string) => string | undefined } } }).Deno;
  const fromDeno = deno?.env?.get?.(name);
  if (fromDeno && fromDeno.trim()) return fromDeno.trim();
  if (typeof process !== "undefined" && process.env[name]?.trim()) return process.env[name]!.trim();
  return "";
}

export const aplicarTrocaApartamentoViaLifecycle: AplicarTrocaApartamento = async (input) => {
  const base = envValue("SUPABASE_URL").replace(/\/+$/, "");
  const key = envValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) return { ok: false, motivo: "lifecycle_indisponivel" };

  const res = await fetch(`${base}/functions/v1/yes-hotel-lifecycle`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "x-yes-internal-caller": "hits-room-change",
    },
    body: JSON.stringify({
      action: "lifecycle_room_change",
      payload: {
        reserva_id: input.reservaId,
        novo_apartamento: input.novoApartamento,
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; motivo?: string; error?: string };
  if (!res.ok || body.ok !== true) {
    return { ok: false, motivo: String(body.motivo || body.error || `lifecycle_${res.status}`) };
  }
  return { ok: true, motivo: String(body.motivo || "reconciliada") };
};
