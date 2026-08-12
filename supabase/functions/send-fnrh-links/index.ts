/**
 * Envio de links FNRH por e-mail (Resend) e WhatsApp (DigiSac).
 * Multicanal ao hóspede: se ambos os contatos forem válidos, tenta os dois
 * de forma independente (sucesso em um não impede o outro). Mesmo link/token.
 * POST: { reserva_id, tipo_evento?, base_url?, check_in_previsto?, job_date? }.
 * Só envia se existir pelo menos 1 FNRH não preenchida.
 * tipo_evento: reserva_criada | d_minus_1 | d0_0700 | porta
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  aggregateGuestChannelResults,
  planGuestChannels,
  type GuestChannelAttempt,
} from "../_shared/comunicacao-operacional/guest-multichannel.ts";
import { outboundWhatsappTransacional } from "../_shared/comunicacao-operacional/outbound-whatsapp.ts";
import { maskEmailForLog, previewCorpo, registrarOperacionalComunicacaoEnvio } from "../_shared/comunicacao-operacional/registro-envio.ts";
import { buildFnrhPreenchimentoUrl, maskFnrhLinkForLog } from "../_shared/fnrh-public-link.ts";

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
  const fnrhPublicEnv = Deno.env.get("FNRH_PUBLIC_BASE_URL");
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
    .select("id, nome, email, whatsapp, tentativas_envio, guest_role")
    .in("id", hospedeIds);

  const now = new Date().toISOString();
  const r = reserva as { apartamento?: string; hospede_principal?: string; check_in_previsto?: string };
  const apartamento = r.apartamento ?? "";
  const checkIn = r.check_in_previsto ?? "";
  const checkInPrevisto = checkInPrevistoPayload || checkIn;

  let enviados = 0;
  let tentativasComEmail = 0;
  let tentativasComWhatsapp = 0;
  let enviadosEmail = 0;
  let enviadosWhatsapp = 0;
  let skippedMinors = 0;
  const erros: string[] = [];

  for (const p of pendentes as { id: string; hospede_id: string; link_token: string; hospede_nome: string }[]) {
    const hospede = (hospedes as {
      id: string;
      nome: string;
      email: string;
      whatsapp: string;
      tentativas_envio?: number;
      guest_role?: string | null;
    }[] | null)?.find((h) => h.id === p.hospede_id);
    // Menores não recebem link próprio — confirmação via responsável.
    if (hospede?.guest_role === "minor") {
      skippedMinors++;
      continue;
    }
    const email = (hospede?.email ?? "").trim();
    const whatsapp = (hospede?.whatsapp ?? "").trim();
    const nome = (hospede?.nome ?? p.hospede_nome ?? "Hóspede").trim();
    // guest_id = fnrh_hospedes.id (formulário público + fnrh-get)
    // Origem = frontend público (FNRH_PUBLIC_BASE_URL), nunca SUPABASE_URL.
    // Mesmo link/token nos dois canais — sem duplicar FNRH.
    const link = buildFnrhPreenchimentoUrl(p.id, p.link_token, {
      baseUrl: body.base_url,
      envValue: fnrhPublicEnv,
      version: 2,
    });

    const plan = planGuestChannels(email, whatsapp, "hospede");
    let emailAttempt: GuestChannelAttempt | null = null;
    let whatsappAttempt: GuestChannelAttempt | null = null;

    if (plan.tryEmail) {
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
        emailAttempt = { status: "enviado" };
        enviadosEmail++;
        await registrarOperacionalComunicacaoEnvio(admin, {
          reserva_id: reservaId,
          conversa_id: null,
          hospede_id: p.hospede_id,
          proposito: "fnrh_links",
          canal: "email",
          destinatario_mascara: maskEmailForLog(email),
          corpo_preview: previewCorpo(`FNRH link: ${maskFnrhLinkForLog(link)}`),
          status: "enviada",
          provider: "resend",
          provider_message_id: null,
          metadata: { tipo_evento: tipoEvento, fnrh_hospede_id: p.id, resource_link: maskFnrhLinkForLog(link) },
          erro: null,
        });
      } else {
        emailAttempt = { status: "falhou", error: result.error ?? "Falha e-mail" };
        erros.push(`${nome}: ${result.error}`);
        await registrarOperacionalComunicacaoEnvio(admin, {
          reserva_id: reservaId,
          conversa_id: null,
          hospede_id: p.hospede_id,
          proposito: "fnrh_links",
          canal: "email",
          destinatario_mascara: maskEmailForLog(email),
          corpo_preview: previewCorpo(`FNRH link: ${maskFnrhLinkForLog(link)}`),
          status: "falha",
          provider: "resend",
          provider_message_id: null,
          metadata: { tipo_evento: tipoEvento, fnrh_hospede_id: p.id },
          erro: result.error ?? "Falha e-mail",
        });
      }
    } else {
      emailAttempt = { status: "indisponivel" };
    }

    // Independente do e-mail: sempre tenta WhatsApp se contato válido (mesmo link).
    if (plan.tryWhatsapp) {
      tentativasComWhatsapp++;
      const textoWhatsapp =
        `Olá, ${nome}! Para agilizar seu check-in${apartamento ? ` no apto ${apartamento}` : ""}${checkIn ? ` (check-in: ${checkIn})` : ""}, preencha sua FNRH pelo link:\n${link}\n\nObrigado!`;
      const wResult = await outboundWhatsappTransacional(admin, {
        reservaId,
        hospedeId: p.hospede_id,
        telefoneRaw: whatsapp,
        text: textoWhatsapp,
        proposito: "fnrh_links",
      });
      if (wResult.ok) {
        whatsappAttempt = { status: "enviado" };
        enviadosWhatsapp++;
      } else {
        whatsappAttempt = { status: "falhou", error: wResult.error ?? "falha" };
        erros.push(`${nome} (WhatsApp): ${wResult.error ?? "falha"}`);
      }
    } else {
      whatsappAttempt = { status: "indisponivel" };
    }

    const agg = aggregateGuestChannelResults(emailAttempt, whatsappAttempt);
    if (agg.delivered) {
      enviados++;
      const tentativas = typeof hospede?.tentativas_envio === "number" ? hospede.tentativas_envio + 1 : 1;
      await admin.from("operacional_hospedes").update({
        status_operacional: "enviado",
        ultimo_envio_canal: agg.ultimoEnvioCanal,
        ultimo_envio_em: now,
        tentativas_envio: tentativas,
        updated_at: now,
      }).eq("id", p.hospede_id);
    }

    if (!plan.tryEmail && !plan.tryWhatsapp) {
      erros.push(`${nome}: sem e-mail e sem WhatsApp cadastrados.`);
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
      enviados_email: enviadosEmail,
      enviados_whatsapp: enviadosWhatsapp,
      skipped_minors: skippedMinors,
      erros: erros.length,
      tentativas_com_email: tentativasComEmail,
      tentativas_com_whatsapp: tentativasComWhatsapp,
      canal_operacional_whatsapp: "digisac",
      multicanal_hospede: true,
      timestamp: now,
    }),
  });

  const adultosPendentes = pendentes.length - skippedMinors;
  const houveTentativa = tentativasComEmail > 0 || tentativasComWhatsapp > 0;
  const nenhumEnviadoAposTentativa =
    adultosPendentes > 0 &&
    enviados === 0 &&
    (houveTentativa || erros.length > 0);

  return jsonResponse(
    {
      ok: !nenhumEnviadoAposTentativa,
      reserva_id: reservaId,
      tipo_evento: tipoEvento,
      enviados,
      enviados_email: enviadosEmail,
      enviados_whatsapp: enviadosWhatsapp,
      skipped_minors: skippedMinors,
      erros: erros.length ? erros : undefined,
      pendentes: pendentes.length,
      ...(nenhumEnviadoAposTentativa
        ? {
          error: erros[0] ??
            "Nenhuma mensagem foi entregue (verifique RESEND_API_KEY, contatos e DigiSac).",
        }
        : {}),
    },
    200,
  );
});
