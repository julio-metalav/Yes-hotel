/**
 * Envio do Payment Link Pagar.me ao hóspede (e-mail Resend + WhatsApp DigiSac).
 * Multicanal: tenta ambos os canais válidos de forma independente.
 * NÃO cria cobrança nem novo Payment Link — só reutiliza o existente.
 *
 * POST: { reserva_id, cobranca_id? }
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  aggregateGuestChannelResults,
  assertSameGuestResource,
  planGuestChannels,
  type GuestChannelAttempt,
} from "../_shared/comunicacao-operacional/guest-multichannel.ts";
import { outboundWhatsappTransacional } from "../_shared/comunicacao-operacional/outbound-whatsapp.ts";
import {
  maskEmailForLog,
  previewCorpo,
  registrarOperacionalComunicacaoEnvio,
} from "../_shared/comunicacao-operacional/registro-envio.ts";
import {
  maskPaymentLinkForLog,
  resolvePaymentLinkForSend,
} from "../../../src/lib/domain/yes-hotel/payment-link-send-policy.ts";

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

async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!resendApiKey) {
    return {
      ok: false,
      error: "RESEND_API_KEY não configurado; nenhum e-mail foi enviado.",
    };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: emailFrom, to: [to], subject, html }),
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

  let body: { reserva_id?: string; cobranca_id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "Body JSON inválido." }, 400);
  }

  const reservaId = (body.reserva_id ?? "").trim();
  if (!reservaId) return jsonResponse({ ok: false, error: "reserva_id obrigatório." }, 400);
  const cobrancaIdWanted = (body.cobranca_id ?? "").trim() || null;

  const { data: reserva, error: errR } = await admin
    .from("operacional_reservas")
    .select("id, apartamento, hospede_principal, pagamento_status")
    .eq("id", reservaId)
    .maybeSingle();
  if (errR || !reserva) return jsonResponse({ ok: false, error: "Reserva não encontrada." }, 404);

  const { data: cobrancas, error: errC } = await admin
    .from("operacional_cobrancas_pagarme")
    .select("id, status, pagarme_payment_link_url")
    .eq("reserva_id", reservaId)
    .order("created_at", { ascending: false });
  if (errC) {
    return jsonResponse({ ok: false, error: "Falha ao listar cobranças." }, 500);
  }

  const resolved = resolvePaymentLinkForSend({
    cobrancas: (cobrancas ?? []) as {
      id: string;
      status: string;
      pagarme_payment_link_url?: string | null;
    }[],
    cobrancaId: cobrancaIdWanted,
  });
  if (!resolved.ok) {
    return jsonResponse(
      {
        ok: false,
        error: resolved.error,
        message: resolved.message,
        reserva_id: reservaId,
      },
      400,
    );
  }

  const paymentLinkUrl = resolved.paymentLinkUrl;
  // Mesmo recurso nos dois canais — nunca gerar segundo link aqui.
  if (!assertSameGuestResource(paymentLinkUrl, paymentLinkUrl)) {
    return jsonResponse({ ok: false, error: "resource_mismatch" }, 500);
  }

  const { data: hospedes } = await admin
    .from("operacional_hospedes")
    .select("id, principal, nome, email, whatsapp")
    .eq("reserva_id", reservaId)
    .order("principal", { ascending: false });
  const principal =
    (hospedes as { principal: boolean; id: string; nome: string; email: string; whatsapp: string }[] | null)
      ?.find((h) => h.principal) ?? hospedes?.[0];

  if (!principal) {
    return jsonResponse({
      ok: false,
      error: "hospede_ausente",
      message: "Inclua o hóspede principal antes de enviar o Payment Link.",
    }, 400);
  }

  const email = String((principal as { email?: string }).email ?? "").trim();
  const whatsapp = String((principal as { whatsapp?: string }).whatsapp ?? "").trim();
  const nome = String((principal as { nome?: string }).nome ?? reserva.hospede_principal ?? "Hóspede").trim();
  const hospedeId = String((principal as { id: string }).id);
  const apartamento = String((reserva as { apartamento?: string }).apartamento ?? "");

  const plan = planGuestChannels(email, whatsapp, "hospede");
  if (!plan.tryEmail && !plan.tryWhatsapp) {
    return jsonResponse({
      ok: false,
      error: "contato_ausente",
      message: "Sem e-mail e sem WhatsApp cadastrados para o hóspede.",
      reserva_id: reservaId,
      cobranca_id: resolved.cobrancaId,
      payment_link_url: paymentLinkUrl,
    }, 400);
  }

  const subject = `Link de pagamento — ${apartamento || "sua reserva"}`;
  const html = `
    <p>Olá, ${nome.replace(/</g, "&lt;")}!</p>
    <p>Segue o link para pagamento da sua hospedagem${apartamento ? ` (apto ${apartamento.replace(/</g, "&lt;")})` : ""}:</p>
    <p><a href="${paymentLinkUrl}">Abrir pagamento</a></p>
    <p>Ou copie e cole no navegador:</p>
    <p style="word-break:break-all">${paymentLinkUrl}</p>
    <p>Obrigado!</p>
  `;
  const textoWhatsapp =
    `Olá, ${nome}! Segue o link para pagamento da sua hospedagem${apartamento ? ` (apto ${apartamento})` : ""}:\n${paymentLinkUrl}\n\nObrigado!`;

  let emailAttempt: GuestChannelAttempt | null = null;
  let whatsappAttempt: GuestChannelAttempt | null = null;
  const masked = maskPaymentLinkForLog(paymentLinkUrl);
  const metaBase = {
    kind: "payment_link",
    cobranca_id: resolved.cobrancaId,
    resource_link: masked,
    multicanal_hospede: true,
  };

  if (plan.tryEmail) {
    const result = await sendEmail(email, subject, html);
    if (result.ok) {
      emailAttempt = { status: "enviado" };
      await registrarOperacionalComunicacaoEnvio(admin, {
        reserva_id: reservaId,
        conversa_id: null,
        hospede_id: hospedeId,
        proposito: "generico",
        canal: "email",
        destinatario_mascara: maskEmailForLog(email),
        corpo_preview: previewCorpo(`Payment link: ${masked}`),
        status: "enviada",
        provider: "resend",
        provider_message_id: null,
        metadata: metaBase,
        erro: null,
      });
    } else {
      emailAttempt = { status: "falhou", error: result.error ?? "Falha e-mail" };
      await registrarOperacionalComunicacaoEnvio(admin, {
        reserva_id: reservaId,
        conversa_id: null,
        hospede_id: hospedeId,
        proposito: "generico",
        canal: "email",
        destinatario_mascara: maskEmailForLog(email),
        corpo_preview: previewCorpo(`Payment link: ${masked}`),
        status: "falha",
        provider: "resend",
        provider_message_id: null,
        metadata: metaBase,
        erro: result.error ?? "Falha e-mail",
      });
    }
  } else {
    emailAttempt = { status: "indisponivel" };
  }

  if (plan.tryWhatsapp) {
    const wResult = await outboundWhatsappTransacional(admin, {
      reservaId,
      hospedeId,
      telefoneRaw: whatsapp,
      text: textoWhatsapp,
      proposito: "generico",
    });
    if (wResult.ok) {
      whatsappAttempt = { status: "enviado" };
    } else {
      whatsappAttempt = { status: "falhou", error: wResult.error ?? "falha" };
    }
  } else {
    whatsappAttempt = { status: "indisponivel" };
  }

  const agg = aggregateGuestChannelResults(emailAttempt, whatsappAttempt);
  const now = new Date().toISOString();

  await admin.from("operacional_reserva_eventos").insert({
    reserva_id: reservaId,
    tipo: "envio_payment_link",
    titulo: "Envio de Payment Link",
    detalhe: JSON.stringify({
      cobranca_id: resolved.cobrancaId,
      payment_link: masked,
      email_status: agg.email,
      whatsapp_status: agg.whatsapp,
      delivered: agg.delivered,
      multicanal_hospede: true,
      timestamp: now,
    }),
  });

  if (agg.ultimoEnvioCanal) {
    await admin.from("operacional_hospedes").update({
      ultimo_envio_canal: agg.ultimoEnvioCanal,
      ultimo_envio_em: now,
      updated_at: now,
    }).eq("id", hospedeId);
  }

  return jsonResponse(
    {
      ok: agg.delivered,
      reserva_id: reservaId,
      cobranca_id: resolved.cobrancaId,
      payment_link_url: paymentLinkUrl,
      enviado_email: agg.emailOk,
      enviado_whatsapp: agg.whatsappOk,
      email_status: agg.email,
      whatsapp_status: agg.whatsapp,
      erros: agg.errors.length ? agg.errors : undefined,
      ...(agg.delivered
        ? {}
        : {
          error: "entrega_falhou",
          message: agg.errors[0] ??
            "Nenhum canal entregou o Payment Link (cobrança preservada).",
        }),
    },
    200,
  );
});
