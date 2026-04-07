/**
 * FNRH digital — leitura por reserva_id (painel) ou guest_id+token (formulário público).
 * Pré-preenche com merge: fnrh_hospedes + operacional_hospedes + operacional_reservas.
 * guest_id = fnrh_hospedes.id (ou legado hospede_id).
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

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** Estados em que o hóspede já encerrou a ficha no Yes (somente leitura no formulário público). */
const STATUS_ENCERRADO_HOSPEDE = new Set([
  "preenchido",
  "confirmado_hospede",
  "enviado_oficial",
  "erro_sincronizacao",
]);

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
      "id, reserva_id, hospede_id, hospede_nome, status, link_token, documento, data_nascimento, nacionalidade, endereco, telefone, email, procedencia, destino, placa_veiculo, cor_veiculo, modelo_veiculo, assinatura_base64, preenchido_em";
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

    const st = str(row.status);
    if (STATUS_ENCERRADO_HOSPEDE.has(st)) {
      if (st === "erro_sincronizacao") {
        return jsonResponse({
          message: "Sua ficha foi confirmada. O envio ao sistema oficial falhou; procure a recepção se precisar.",
          status: st,
          fechado: true,
        });
      }
      if (st === "enviado_oficial") {
        return jsonResponse({
          message: "FNRH confirmada e registrada com sucesso.",
          status: st,
          fechado: true,
        });
      }
      return jsonResponse({ message: "Esta FNRH já foi preenchida e confirmada.", status: st === "preenchido" ? "confirmado_hospede" : st, fechado: true });
    }

    const hospedeOperacionalId = str(row.hospede_id);
    const reservaFk = str(row.reserva_id);

    const { data: hospede } = await admin
      .from("operacional_hospedes")
      .select("principal, nome, email, whatsapp")
      .eq("id", hospedeOperacionalId)
      .maybeSingle();
    const h = hospede as { principal?: boolean; nome?: string; email?: string; whatsapp?: string } | null;

    const { data: resv } = await admin
      .from("operacional_reservas")
      .select("hospede_principal, check_in_previsto, check_out_previsto, veiculo_placa, veiculo_cor, apartamento")
      .eq("id", reservaFk)
      .maybeSingle();
    const rv = resv as {
      hospede_principal?: string;
      check_in_previsto?: string;
      check_out_previsto?: string;
      veiculo_placa?: string;
      veiculo_cor?: string;
      apartamento?: string;
    } | null;

    const pick = (dbVal: unknown, fallback: string) => {
      const d = str(dbVal);
      return d !== "" ? d : fallback;
    };

    const nomeHotel = str(rv?.hospede_principal);
    const hintDestino = rv?.check_out_previsto
      ? `Saída prevista ${String(rv.check_out_previsto).slice(0, 10)}`
      : "";

    const preenchido = {
      hospede_nome: pick(row.hospede_nome, pick(h?.nome, nomeHotel)),
      documento: pick(row.documento, ""),
      data_nascimento: row.data_nascimento ?? null,
      nacionalidade: pick(row.nacionalidade, ""),
      endereco: pick(row.endereco, ""),
      telefone: pick(row.telefone, str(h?.whatsapp)),
      email: pick(row.email, str(h?.email)),
      procedencia: pick(row.procedencia, ""),
      destino: pick(row.destino, hintDestino),
      placa_veiculo: pick(row.placa_veiculo, str(rv?.veiculo_placa)),
      cor_veiculo: pick(row.cor_veiculo, str(rv?.veiculo_cor)),
      modelo_veiculo: pick(row.modelo_veiculo, ""),
    };

    const principal = !!h?.principal;

    return jsonResponse({
      hospede_id: row.hospede_id,
      hospede_nome: preenchido.hospede_nome,
      reserva_id: row.reserva_id,
      status: st,
      principal,
      editavel: true,
      meta: {
        apartamento: str(rv?.apartamento),
        check_in_previsto: rv?.check_in_previsto ?? null,
        check_out_previsto: rv?.check_out_previsto ?? null,
      },
      preenchido,
      assinatura_base64: row.assinatura_base64 ?? null,
    });
  }

  return jsonResponse({ error: "Informe reserva_id ou guest_id e token." }, 400);
});
