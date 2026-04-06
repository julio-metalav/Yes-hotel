/**
 * FNRH digital — leitura por reserva_id (painel) ou por guest_id+token (formulário público).
 * GET ?reserva_id=uuid → lista de FNRH da reserva + status agregado.
 * GET ?guest_id=uuid&token=xxx → dados para o formulário público.
 * guest_id preferencialmente = fnrh_hospedes.id; ainda aceita operacional_hospedes.id (hospede_id) por compatibilidade.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ error: "Método não permitido." }, 405);

  const url = new URL(req.url);
  const reservaId = url.searchParams.get("reserva_id")?.trim();
  const guestId = url.searchParams.get("guest_id")?.trim();
  const token = url.searchParams.get("token")?.trim();

  if (reservaId) {
    const { data: reserva, error: errReserva } = await admin
      .from("operacional_reservas")
      .select("id, fnrh_status_agregado")
      .eq("id", reservaId)
      .maybeSingle();
    if (errReserva || !reserva) {
      return jsonResponse({ error: "Reserva não encontrada." }, 404);
    }
    const { data: list, error: errList } = await admin
      .from("fnrh_hospedes")
      .select("id, hospede_id, hospede_nome, status, preenchido_em, link_token")
      .eq("reserva_id", reservaId)
      .order("created_at", { ascending: true });
    if (errList) return jsonResponse({ error: "Falha ao listar FNRH." }, 500);
    return jsonResponse({
      reserva_id: reservaId,
      fnrh_status_agregado: (reserva as { fnrh_status_agregado: string }).fnrh_status_agregado ?? "fnrh_pendente",
      hospedes: (list ?? []).map((r: Record<string, unknown>) => ({
        hospede_id: r.hospede_id,
        hospede_nome: r.hospede_nome,
        status: r.status,
        preenchido_em: r.preenchido_em,
        link_token: r.link_token,
      })),
    });
  }

  if (guestId && token) {
    const sel =
      "id, reserva_id, hospede_id, hospede_nome, status, link_token, documento, data_nascimento, nacionalidade, endereco, telefone, email, procedencia, destino, placa_veiculo, cor_veiculo, modelo_veiculo";
    let row: Record<string, unknown> | null = null;
    const { data: byFnrhId, error: errId } = await admin.from("fnrh_hospedes").select(sel).eq("id", guestId).eq("link_token", token).maybeSingle();
    if (errId) return jsonResponse({ error: "Falha ao validar link." }, 500);
    if (byFnrhId) row = byFnrhId as Record<string, unknown>;
    if (!row) {
      const { data: byHospedeId, error: errH } = await admin.from("fnrh_hospedes").select(sel).eq("hospede_id", guestId).eq("link_token", token).maybeSingle();
      if (errH) return jsonResponse({ error: "Falha ao validar link." }, 500);
      if (byHospedeId) row = byHospedeId as Record<string, unknown>;
    }
    if (!row) {
      return jsonResponse({ error: "Link inválido ou expirado." }, 404);
    }
    const r = row;
    if (r.status === "preenchido") {
      return jsonResponse({ message: "FNRH já preenchida.", status: "preenchido" });
    }
    const hospedeOperacionalId = String(r.hospede_id ?? "");
    const { data: hospede } = await admin
      .from("operacional_hospedes")
      .select("principal")
      .eq("id", hospedeOperacionalId)
      .maybeSingle();
    const principal = !!(hospede as { principal?: boolean } | null)?.principal;
    return jsonResponse({
      hospede_id: r.hospede_id,
      hospede_nome: r.hospede_nome,
      reserva_id: r.reserva_id,
      status: r.status,
      principal,
      preenchido: {
        documento: r.documento ?? "",
        data_nascimento: r.data_nascimento ?? null,
        nacionalidade: r.nacionalidade ?? "",
        endereco: r.endereco ?? "",
        telefone: r.telefone ?? "",
        email: r.email ?? "",
        procedencia: r.procedencia ?? "",
        destino: r.destino ?? "",
        placa_veiculo: r.placa_veiculo ?? "",
        cor_veiculo: r.cor_veiculo ?? "",
        modelo_veiculo: r.modelo_veiculo ?? "",
      },
    });
  }

  return jsonResponse({ error: "Informe reserva_id ou guest_id e token." }, 400);
});
