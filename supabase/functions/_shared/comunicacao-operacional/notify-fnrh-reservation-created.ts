/**
 * Dispara send-fnrh-links com tipo_evento=reserva_criada.
 * Fire-and-forget seguro: falha de Resend/DigiSac NÃO deve derrubar persistência da reserva.
 */
export type NotifyFnrhReservationCreatedResult = {
  reserva_id: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  enviados_email?: number;
  enviados_whatsapp?: number;
};

export async function notifyFnrhLinksOnReservationCreated(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  anonOrServiceKey?: string;
  reservaId: string;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<NotifyFnrhReservationCreatedResult> {
  const reservaId = String(input.reservaId ?? "").trim();
  if (!reservaId) {
    return { reserva_id: "", ok: false, error: "reserva_id_obrigatorio" };
  }
  const base = String(input.supabaseUrl ?? "").replace(/\/+$/, "");
  const key = String(input.serviceRoleKey ?? "").trim();
  if (!base || !key) {
    return { reserva_id: reservaId, ok: false, error: "supabase_admin_unavailable" };
  }
  const apikey = String(input.anonOrServiceKey ?? key).trim() || key;
  const fetchFn = input.fetchImpl ?? fetch;

  try {
    const res = await fetchFn(`${base}/functions/v1/send-fnrh-links`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        reserva_id: reservaId,
        tipo_evento: "reserva_criada",
        ...(input.baseUrl ? { base_url: input.baseUrl } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      message?: string;
      enviados_email?: number;
      enviados_whatsapp?: number;
    };
    if (!res.ok) {
      return {
        reserva_id: reservaId,
        ok: false,
        error: data.error ?? data.message ?? `HTTP ${res.status}`,
      };
    }
    return {
      reserva_id: reservaId,
      ok: data.ok !== false,
      error: data.ok === false ? data.error ?? data.message : undefined,
      enviados_email: data.enviados_email,
      enviados_whatsapp: data.enviados_whatsapp,
    };
  } catch (e) {
    return {
      reserva_id: reservaId,
      ok: false,
      error: e instanceof Error ? e.message.slice(0, 200) : "notify_fnrh_failed",
    };
  }
}

export async function notifyFnrhLinksForCreatedReservations(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  anonOrServiceKey?: string;
  reservaIds: string[];
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  attempted: number;
  ok: number;
  failed: number;
  results: NotifyFnrhReservationCreatedResult[];
}> {
  const ids = [...new Set((input.reservaIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
  const results: NotifyFnrhReservationCreatedResult[] = [];
  for (const reservaId of ids) {
    const r = await notifyFnrhLinksOnReservationCreated({
      ...input,
      reservaId,
    });
    results.push(r);
  }
  return {
    attempted: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
