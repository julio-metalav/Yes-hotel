/**
 * FNRH digital — submissão do formulário (público, validado por token).
 * POST: body { hospede_id, token, ... }; hospede_id = fnrh_hospedes.id (preferido) ou operacional_hospedes.id legado.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ensureString(v: unknown, def = ""): string {
  if (v == null) return def;
  return String(v).trim();
}

function ensureDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : s.slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Método não permitido." }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Body JSON inválido." }, 400);
  }

  const publicKey = ensureString(body.hospede_id);
  const token = ensureString(body.token);
  if (!publicKey || !token) {
    return jsonResponse({ ok: false, error: "hospede_id e token são obrigatórios." }, 400);
  }

  const sel = "id, reserva_id, hospede_id, status";
  let row: { id: string; reserva_id: string; hospede_id: string; status: string } | null = null;
  const { data: byFnrhId, error: errId } = await admin.from("fnrh_hospedes").select(sel).eq("id", publicKey).eq("link_token", token).maybeSingle();
  if (errId) return jsonResponse({ ok: false, error: "Falha ao validar link." }, 500);
  if (byFnrhId) row = byFnrhId as typeof row;
  if (!row) {
    const { data: byHospedeId, error: errH } = await admin.from("fnrh_hospedes").select(sel).eq("hospede_id", publicKey).eq("link_token", token).maybeSingle();
    if (errH) return jsonResponse({ ok: false, error: "Falha ao validar link." }, 500);
    if (byHospedeId) row = byHospedeId as typeof row;
  }
  if (!row) {
    return jsonResponse({ ok: false, error: "Link inválido ou expirado." }, 404);
  }
  if ((row as { status: string }).status === "preenchido") {
    return jsonResponse({ ok: true, message: "FNRH já foi preenchida para este hóspede." });
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    hospede_nome: ensureString(body.hospede_nome),
    documento: ensureString(body.documento),
    data_nascimento: ensureDate(body.data_nascimento),
    nacionalidade: ensureString(body.nacionalidade),
    endereco: ensureString(body.endereco),
    telefone: ensureString(body.telefone),
    email: ensureString(body.email),
    procedencia: ensureString(body.procedencia),
    destino: ensureString(body.destino),
    placa_veiculo: ensureString(body.placa_veiculo ?? ""),
    cor_veiculo: ensureString(body.cor_veiculo ?? ""),
    modelo_veiculo: ensureString(body.modelo_veiculo ?? ""),
    assinatura_base64: body.assinatura_base64 != null ? String(body.assinatura_base64) : null,
    status: "preenchido",
    preenchido_em: now,
    updated_at: now,
  };

  const { error: updateErr } = await admin
    .from("fnrh_hospedes")
    .update(update)
    .eq("id", (row as { id: string }).id);

  if (updateErr) {
    return jsonResponse({ ok: false, error: "Falha ao salvar FNRH." }, 500);
  }

  const reservaId = (row as { reserva_id: string }).reserva_id;
  const email = ensureString(body.email);
  const telefone = ensureString(body.telefone);
  const hospedeUpdate: Record<string, unknown> = { status_operacional: "confirmado", updated_at: now };
  if (email) hospedeUpdate.email = email;
  if (telefone) hospedeUpdate.whatsapp = telefone;
  await admin.from("operacional_hospedes").update(hospedeUpdate).eq("id", row.hospede_id);

  const { count: total } = await admin
    .from("fnrh_hospedes")
    .select("id", { count: "exact", head: true })
    .eq("reserva_id", reservaId);
  const { count: preenchidos } = await admin
    .from("fnrh_hospedes")
    .select("id", { count: "exact", head: true })
    .eq("reserva_id", reservaId)
    .eq("status", "preenchido");

  const agregado =
    (preenchidos ?? 0) === 0
      ? "fnrh_pendente"
      : (preenchidos ?? 0) < (total ?? 0)
        ? "fnrh_parcial"
        : "fnrh_completo";

  await admin
    .from("operacional_reservas")
    .update({ fnrh_status_agregado: agregado, updated_at: now })
    .eq("id", reservaId);

  await syncFnrhToHits(admin, (row as { id: string }).id, reservaId, now);

  return jsonResponse({
    ok: true,
    message: "FNRH registrada com sucesso.",
    reserva_id: reservaId,
    fnrh_status_agregado: agregado,
  });
});

async function syncFnrhToHits(
  client: ReturnType<typeof createClient>,
  fnrhId: string,
  reservaId: string,
  now: string,
): Promise<void> {
  const hitsWebhookUrl = Deno.env.get("HITS_FNRH_WEBHOOK_URL")?.trim();
  if (!hitsWebhookUrl) {
    await client
      .from("fnrh_hospedes")
      .update({
        fnrh_sync_status: "pendente",
        fnrh_sync_erro: "HITS_FNRH_WEBHOOK_URL não configurado.",
        updated_at: now,
      })
      .eq("id", fnrhId);
    await client.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "fnrh_sync_hits",
      titulo: "Sync FNRH → HITS",
      detalhe: JSON.stringify({ status: "pendente", erro: "HITS_FNRH_WEBHOOK_URL não configurado." }),
    });
    return;
  }
  try {
    const { data: fnrh } = await client
      .from("fnrh_hospedes")
      .select("hospede_nome, documento, data_nascimento, nacionalidade, endereco, telefone, email, procedencia, destino, placa_veiculo, cor_veiculo, modelo_veiculo")
      .eq("id", fnrhId)
      .single();
    if (!fnrh) return;
    const payload = {
      reserva_id: reservaId,
      fnrh_id: fnrhId,
      hospede_nome: (fnrh as Record<string, unknown>).hospede_nome,
      documento: (fnrh as Record<string, unknown>).documento,
      data_nascimento: (fnrh as Record<string, unknown>).data_nascimento,
      nacionalidade: (fnrh as Record<string, unknown>).nacionalidade,
      endereco: (fnrh as Record<string, unknown>).endereco,
      telefone: (fnrh as Record<string, unknown>).telefone,
      email: (fnrh as Record<string, unknown>).email,
      procedencia: (fnrh as Record<string, unknown>).procedencia,
      destino: (fnrh as Record<string, unknown>).destino,
      placa_veiculo: (fnrh as Record<string, unknown>).placa_veiculo,
      cor_veiculo: (fnrh as Record<string, unknown>).cor_veiculo,
      modelo_veiculo: (fnrh as Record<string, unknown>).modelo_veiculo,
    };
    const res = await fetch(hitsWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const ok = res.ok;
    const errText = ok ? null : await res.text();
    await client
      .from("fnrh_hospedes")
      .update({
        fnrh_sync_status: ok ? "enviado" : "erro",
        fnrh_sync_enviado_em: now,
        fnrh_sync_erro: errText?.slice(0, 500) ?? (ok ? null : `HTTP ${res.status}`),
        updated_at: now,
      })
      .eq("id", fnrhId);
    await client.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "fnrh_sync_hits",
      titulo: "Sync FNRH → HITS",
      detalhe: JSON.stringify({ status: ok ? "enviado" : "erro", erro: errText ?? null }),
    });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    await client
      .from("fnrh_hospedes")
      .update({
        fnrh_sync_status: "erro",
        fnrh_sync_enviado_em: now,
        fnrh_sync_erro: errMsg.slice(0, 500),
        updated_at: now,
      })
      .eq("id", fnrhId);
    await client.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "fnrh_sync_hits",
      titulo: "Sync FNRH → HITS",
      detalhe: JSON.stringify({ status: "erro", erro: errMsg }),
    });
  }
}
