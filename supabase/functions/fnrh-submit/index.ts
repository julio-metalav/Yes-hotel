/**
 * FNRH digital — público (token).
 * POST action "draft" | "confirm" (omitido = confirm, compatível com fluxo antigo).
 * draft: autosave parcial, status → rascunho (não confirma hóspede no operacional).
 * confirm: assinatura + campos obrigatórios, status → confirmado_hospede, sync HITS, agregado reserva.
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

const STATUS_FINAL_HOSPEDE = new Set([
  "preenchido",
  "confirmado_hospede",
  "enviado_oficial",
  "erro_sincronizacao",
]);

const STATUS_CONTA_FNrh_COMPLETO = ["confirmado_hospede", "enviado_oficial", "erro_sincronizacao", "preenchido"];

const DRAFT_KEYS = [
  "hospede_nome",
  "documento",
  "data_nascimento",
  "nacionalidade",
  "endereco",
  "telefone",
  "email",
  "procedencia",
  "destino",
  "placa_veiculo",
  "cor_veiculo",
  "modelo_veiculo",
  "assinatura_base64",
] as const;

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

type FnrhRow = { id: string; reserva_id: string; hospede_id: string; status: string };

async function resolveFnrhRow(
  publicKey: string,
  token: string,
): Promise<{ row: FnrhRow | null; error?: string }> {
  const sel = "id, reserva_id, hospede_id, status";
  let row: FnrhRow | null = null;
  const { data: byFnrhId, error: errId } = await admin.from("fnrh_hospedes").select(sel).eq("id", publicKey).eq("link_token", token).maybeSingle();
  if (errId) return { row: null, error: "Falha ao validar link." };
  if (byFnrhId) row = byFnrhId as FnrhRow;
  if (!row) {
    const { data: byHospedeId, error: errH } = await admin.from("fnrh_hospedes").select(sel).eq("hospede_id", publicKey).eq("link_token", token).maybeSingle();
    if (errH) return { row: null, error: "Falha ao validar link." };
    if (byHospedeId) row = byHospedeId as FnrhRow;
  }
  return { row };
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

  const actionRaw = ensureString(body.action).toLowerCase();
  const isDraft = actionRaw === "draft";

  const { row, error: resolveErr } = await resolveFnrhRow(publicKey, token);
  if (resolveErr) return jsonResponse({ ok: false, error: resolveErr }, 500);
  if (!row) {
    return jsonResponse({ ok: false, error: "Link inválido ou expirado." }, 404);
  }

  if (STATUS_FINAL_HOSPEDE.has(row.status)) {
    return jsonResponse({ ok: true, message: "FNRH já foi finalizada para este hóspede.", idempotente: true });
  }

  const now = new Date().toISOString();

  if (isDraft) {
    const update: Record<string, unknown> = { updated_at: now, status: "rascunho" };
    for (const k of DRAFT_KEYS) {
      if (!(k in body)) continue;
      const v = body[k];
      if (k === "data_nascimento") {
        update[k] = ensureDate(v);
      } else if (k === "assinatura_base64") {
        update[k] = v != null && String(v).trim() !== "" ? String(v) : null;
      } else {
        update[k] = v != null ? String(v) : "";
      }
    }
    const { error: upErr } = await admin.from("fnrh_hospedes").update(update).eq("id", row.id);
    if (upErr) {
      return jsonResponse({ ok: false, error: "Falha ao salvar rascunho." }, 500);
    }
    const email = ensureString(body.email);
    const telefone = ensureString(body.telefone);
    const hu: Record<string, unknown> = { updated_at: now };
    if (email) hu.email = email;
    if (telefone) hu.whatsapp = telefone;
    if (email || telefone) {
      await admin.from("operacional_hospedes").update(hu).eq("id", row.hospede_id);
    }
    return jsonResponse({ ok: true, message: "Rascunho salvo.", status: "rascunho" });
  }

  const hospede_nome = ensureString(body.hospede_nome);
  const documento = ensureString(body.documento);
  const nacionalidade = ensureString(body.nacionalidade);
  const endereco = ensureString(body.endereco);
  const telefone = ensureString(body.telefone);
  const email = ensureString(body.email);
  const procedencia = ensureString(body.procedencia);
  const destino = ensureString(body.destino);
  if (!hospede_nome || !documento || !nacionalidade || !endereco || !telefone || !email || !procedencia || !destino) {
    return jsonResponse({ ok: false, error: "Preencha todos os campos obrigatórios antes de confirmar." }, 400);
  }
  const assinatura = body.assinatura_base64 != null ? String(body.assinatura_base64).trim() : "";
  if (!assinatura) {
    return jsonResponse({ ok: false, error: "Assinatura obrigatória para confirmar a FNRH." }, 400);
  }

  const update: Record<string, unknown> = {
    hospede_nome,
    documento,
    data_nascimento: ensureDate(body.data_nascimento),
    nacionalidade,
    endereco,
    telefone,
    email,
    procedencia,
    destino,
    placa_veiculo: ensureString(body.placa_veiculo ?? ""),
    cor_veiculo: ensureString(body.cor_veiculo ?? ""),
    modelo_veiculo: ensureString(body.modelo_veiculo ?? ""),
    assinatura_base64: assinatura,
    status: "confirmado_hospede",
    preenchido_em: now,
    updated_at: now,
  };

  const { error: updateErr } = await admin.from("fnrh_hospedes").update(update).eq("id", row.id);

  if (updateErr) {
    return jsonResponse({ ok: false, error: "Falha ao salvar FNRH." }, 500);
  }

  const reservaId = row.reserva_id;
  const hospedeUpdate: Record<string, unknown> = { status_operacional: "confirmado", updated_at: now };
  if (email) hospedeUpdate.email = email;
  if (telefone) hospedeUpdate.whatsapp = telefone;
  await admin.from("operacional_hospedes").update(hospedeUpdate).eq("id", row.hospede_id);

  const { count: total } = await admin
    .from("fnrh_hospedes")
    .select("id", { count: "exact", head: true })
    .eq("reserva_id", reservaId);
  const { count: completos } = await admin
    .from("fnrh_hospedes")
    .select("id", { count: "exact", head: true })
    .eq("reserva_id", reservaId)
    .in("status", STATUS_CONTA_FNrh_COMPLETO);

  const agregado =
    (completos ?? 0) === 0
      ? "fnrh_pendente"
      : (completos ?? 0) < (total ?? 0)
        ? "fnrh_parcial"
        : "fnrh_completo";

  await admin
    .from("operacional_reservas")
    .update({ fnrh_status_agregado: agregado, updated_at: now })
    .eq("id", reservaId);

  await syncFnrhToHits(admin, row.id, reservaId, now);

  if (agregado === "fnrh_completo") {
    await maybeDispararLiberacaoPorRequisitos(reservaId);
  }

  return jsonResponse({
    ok: true,
    message: "FNRH confirmada com sucesso.",
    reserva_id: reservaId,
    fnrh_status_agregado: agregado,
    status: "confirmado_hospede",
  });
});

/**
 * Quando FNRH fecha por último: se pagamento já estiver ok e senha não enviada,
 * dispara o fluxo existente send-senha (automático). Idempotente via senha_enviada_em.
 */
async function maybeDispararLiberacaoPorRequisitos(reservaId: string): Promise<void> {
  try {
    const { data: reserva } = await admin
      .from("operacional_reservas")
      .select("id, pagamento_status, senha_enviada_em, acesso_liberado")
      .eq("id", reservaId)
      .maybeSingle();
    if (!reserva) return;
    if ((reserva as { senha_enviada_em?: string | null }).senha_enviada_em) return;
    if ((reserva as { pagamento_status?: string }).pagamento_status !== "pago") return;

    if (!(reserva as { acesso_liberado?: boolean }).acesso_liberado) {
      await admin
        .from("operacional_reservas")
        .update({ acesso_liberado: true, updated_at: new Date().toISOString() })
        .eq("id", reservaId);
    }

    const sendUrl = `${supabaseUrl}/functions/v1/send-senha`;
    const res = await fetch(sendUrl, {
      method: "POST",
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        reserva_id: reservaId,
        manual: false,
        origem: "requisitos",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn("[fnrh-submit] liberação por requisitos falhou:", data);
      await admin.from("operacional_reserva_eventos").insert({
        reserva_id: reservaId,
        tipo: "falha_enviar_credenciais",
        titulo: "Falha ao enviar credenciais",
        detalhe: JSON.stringify({
          origem: "requisitos",
          erro: (data as { error?: string }).error || res.statusText,
        }),
      });
    }
  } catch (error) {
    console.warn("[fnrh-submit] maybeDispararLiberacaoPorRequisitos:", error);
  }
}

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
        status: ok ? "enviado_oficial" : "erro_sincronizacao",
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
        status: "erro_sincronizacao",
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
