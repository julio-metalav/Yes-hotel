/**
 * Envio de links FNRH por e-mail (e preparação para WhatsApp).
 * POST: { reserva_id, tipo_evento?, base_url?, check_in_previsto?, job_date? }.
 * Só envia se existir pelo menos 1 FNRH não preenchida.
 * tipo_evento: reserva_criada | d_minus_1 | d0_0700 | porta
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const resendApiKey = Deno.env.get("RESEND_API_KEY")?.trim();
const emailFrom = Deno.env.get("YES_HOTEL_EMAIL_FROM")?.trim() || "checkin@yeshotel.local";

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  if (!resendApiKey) {
    console.warn("[send-fnrh-links] RESEND_API_KEY não configurado; e-mail não enviado.");
    return {
      ok: false,
      error: "RESEND_API_KEY não configurado; nenhum e-mail foi enviado.",
    };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [to],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Método não permitido." }, 405);

  let body: { reserva_id?: string; tipo_evento?: string; base_url?: string; check_in_previsto?: string; job_date?: string };
  try {
    body = (await req.json()) as { reserva_id?: string; tipo_evento?: string; base_url?: string; check_in_previsto?: string; job_date?: string };
  } catch {
    return jsonResponse({ ok: false, error: "Body JSON inválido." }, 400);
  }

  const reservaId = (body.reserva_id ?? "").trim();
  if (!reservaId) return jsonResponse({ ok: false, error: "reserva_id obrigatório." }, 400);

  const tipoEvento = (body.tipo_evento ?? "").trim() || "manual";
  const baseUrl = (body.base_url ?? "").trim().replace(/\/+$/, "") || supabaseUrl.replace("/v1", "");
  const checkInPrevistoPayload = (body.check_in_previsto ?? "").trim();
  const jobDate = (body.job_date ?? "").trim();

  const { data: reserva, error: errR } = await admin
    .from("operacional_reservas")
    .select("id, apartamento, hospede_principal, check_in_previsto")
    .eq("id", reservaId)
    .maybeSingle();
  if (errR || !reserva) return jsonResponse({ ok: false, error: "Reserva não encontrada." }, 404);

  const { data: fnrhList, error: errF } = await admin
    .from("fnrh_hospedes")
    .select("id, hospede_id, link_token, hospede_nome, status")
    .eq("reserva_id", reservaId);
  if (errF || !Array.isArray(fnrhList)) return jsonResponse({ ok: false, error: "Falha ao listar FNRH." }, 500);

  const aberto = new Set(["pendente", "rascunho", "pendente_confirmacao"]);
  const pendentes = fnrhList.filter((r: { status: string }) => aberto.has(r.status));
  if (pendentes.length === 0) {
    return jsonResponse(
      {
        ok: true,
        enviados: 0,
        message: "Nenhuma FNRH pendente; envio omitido.",
        reserva_id: reservaId,
      },
      200,
    );
  }

  const hospedeIds = pendentes.map((r: { hospede_id: string }) => r.hospede_id);
  const { data: hospedes } = await admin
    .from("operacional_hospedes")
    .select("id, nome, email, whatsapp, tentativas_envio")
    .in("id", hospedeIds);

  const now = new Date().toISOString();
  const r = reserva as { apartamento?: string; hospede_principal?: string; check_in_previsto?: string };
  const apartamento = r.apartamento ?? "";
  const checkIn = r.check_in_previsto ?? "";
  const checkInPrevisto = checkInPrevistoPayload || checkIn;

  let enviados = 0;
  let tentativasComEmail = 0;
  const erros: string[] = [];

  for (const p of pendentes as { id: string; hospede_id: string; link_token: string; hospede_nome: string }[]) {
    const hospede = (hospedes as { id: string; nome: string; email: string; whatsapp: string }[] | null)?.find((h) => h.id === p.hospede_id);
    const email = (hospede?.email ?? "").trim();
    const nome = (hospede?.nome ?? p.hospede_nome ?? "Hóspede").trim();
    // guest_id = fnrh_hospedes.id (formulário público + fnrh-get)
    const link = `${baseUrl}/fnrh-preenchimento.html?v=2&guest_id=${encodeURIComponent(p.id)}&token=${encodeURIComponent(p.link_token)}`;

    if (email) {
      tentativasComEmail++;
      const subject = `Ficha de Registro (FNRH) — ${apartamento || "sua reserva"}`;
      const html = `
        <p>Olá, ${nome.replace(/</g, "&lt;")}!</p>
        <p>Para agilizar seu check-in${apartamento ? ` no apartamento ${apartamento}` : ""}${checkIn ? ` (check-in previsto: ${checkIn})` : ""}, preencha sua Ficha Nacional de Registro de Hóspedes (FNRH) pelo link abaixo:</p>
        <p><a href="${link}">Abrir formulário FNRH</a></p>
        <p>Ou copie e cole no navegador:</p>
        <p style="word-break:break-all">${link}</p>
        <p>Obrigado!</p>
      `;
      const result = await sendEmail(email, subject, html);
      if (result.ok) {
        enviados++;
        const tentativas = typeof (hospede as { tentativas_envio?: number })?.tentativas_envio === "number" ? (hospede as { tentativas_envio: number }).tentativas_envio + 1 : 1;
        await admin.from("operacional_hospedes").update({
          status_operacional: "enviado",
          ultimo_envio_canal: "email",
          ultimo_envio_em: now,
          tentativas_envio: tentativas,
          updated_at: now,
        }).eq("id", p.hospede_id);
      } else {
        erros.push(`${nome}: ${result.error}`);
      }
    }
  }

  await admin.from("operacional_reserva_eventos").insert({
    reserva_id: reservaId,
    tipo: "envio_auto_fnrh",
    titulo: "Envio de links FNRH",
    detalhe: JSON.stringify({
      tipo_evento: tipoEvento,
      check_in_previsto: checkInPrevisto,
      job_date: jobDate || null,
      enviados,
      erros: erros.length,
      tentativas_com_email: tentativasComEmail,
      timestamp: now,
    }),
  });

  const nenhumEmailEnviadoAposTentativa = tentativasComEmail > 0 && enviados === 0;

  return jsonResponse(
    {
      ok: !nenhumEmailEnviadoAposTentativa,
      reserva_id: reservaId,
      tipo_evento: tipoEvento,
      enviados,
      erros: erros.length ? erros : undefined,
      pendentes: pendentes.length,
      ...(nenhumEmailEnviadoAposTentativa
        ? {
          error: erros[0] ??
            "Nenhum e-mail foi entregue (verifique RESEND_API_KEY e destinatários).",
        }
        : {}),
    },
    200,
  );
});
