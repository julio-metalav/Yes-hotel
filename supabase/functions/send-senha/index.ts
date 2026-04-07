/**
 * Envio de senha TTLock + links FNRH (manual ou automático).
 * E-mail via Resend; WhatsApp via camada DigiSac (stub/real).
 * POST: { reserva_id, manual?: boolean, usuario_id?: string, email?: string, whatsapp?: string }.
 * Se manual e email/whatsapp informados, salva nos contatos do hóspede principal.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import { outboundWhatsappTransacional } from "../_shared/comunicacao-operacional/outbound-whatsapp.ts";
import { maskEmailForLog, previewCorpo, registrarOperacionalComunicacaoEnvio } from "../_shared/comunicacao-operacional/registro-envio.ts";

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
    console.warn("[send-senha] RESEND_API_KEY não configurado; e-mail não enviado.");
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

  let body: { reserva_id?: string; manual?: boolean; usuario_id?: string; email?: string; whatsapp?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ ok: false, error: "Body JSON inválido." }, 400);
  }

  const reservaId = (body.reserva_id ?? "").trim();
  if (!reservaId) return jsonResponse({ ok: false, error: "reserva_id obrigatório." }, 400);

  const isManual = !!body.manual;
  const emailContato = (body.email ?? "").trim();
  const whatsappContato = (body.whatsapp ?? "").trim();
  const usuarioId = (body.usuario_id ?? "").trim();

  const { data: reserva, error: errR } = await admin
    .from("operacional_reservas")
    .select("id, apartamento, hospede_principal, check_in_previsto, senha_enviada_em")
    .eq("id", reservaId)
    .maybeSingle();
  if (errR || !reserva) return jsonResponse({ ok: false, error: "Reserva não encontrada." }, 404);

  const { data: credencial, error: errC } = await admin
    .from("operacional_credenciais_acesso")
    .select("id, codigo_credencial, status")
    .eq("reserva_id", reservaId)
    .eq("tipo_credencial", "principal")
    .maybeSingle();

  if (errC || !credencial) {
    return jsonResponse({
      ok: false,
      error: "Nenhuma credencial de acesso para esta reserva. Libere o acesso no painel primeiro.",
    }, 400);
  }

  let passcode = (credencial as { codigo_credencial?: string | null }).codigo_credencial;
  if (!passcode) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const lifecycleUrl = `${supabaseUrl}/functions/v1/yes-hotel-lifecycle`;
    const provisionRes = await fetch(lifecycleUrl, {
      method: "POST",
      headers: { ...corsHeaders, "Content-Type": "application/json", "Authorization": authHeader },
      body: JSON.stringify({ action: "lifecycle_provision", payload: { reservaId } }),
    });
    const provisionData = await provisionRes.json().catch(() => ({})) as { passcode?: string; error?: string };
    if (provisionData.error || !provisionData.passcode) {
      return jsonResponse({
        ok: false,
        error: provisionData.error ?? "Falha ao provisionar senha. Tente liberar acesso e provisionar no painel.",
      }, 400);
    }
    passcode = provisionData.passcode;
  }

  const { data: hospedes } = await admin
    .from("operacional_hospedes")
    .select("id, principal, nome, email, whatsapp")
    .eq("reserva_id", reservaId)
    .order("principal", { ascending: false });
  const principal = (hospedes as { principal: boolean; id: string; nome: string; email: string; whatsapp: string }[] | null)?.find((h) => h.principal) ?? hospedes?.[0];

  let emailTo = (principal as { email?: string })?.email?.trim() || emailContato;
  const whatsappTo = (principal as { whatsapp?: string })?.whatsapp?.trim() || whatsappContato;

  if (isManual && (emailContato || whatsappContato)) {
    if (!emailTo && !whatsappTo) {
      return jsonResponse({ ok: false, error: "Informe pelo menos um contato (e-mail ou WhatsApp)." }, 400);
    }
    if (emailContato) emailTo = emailContato;
    if (principal && (emailContato || whatsappContato)) {
      await admin.from("operacional_hospedes").update({
        ...(emailContato ? { email: emailContato } : {}),
        ...(whatsappContato ? { whatsapp: whatsappContato } : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", (principal as { id: string }).id);
    }
  }

  if (!emailTo && !whatsappTo) {
    return jsonResponse({
      ok: false,
      error: "Nenhum e-mail ou WhatsApp para envio. Preencha os contatos do hóspede principal ou informe no modal.",
    }, 400);
  }

  const baseUrl = supabaseUrl.replace("/v1", "");
  const { data: fnrhList } = await admin
    .from("fnrh_hospedes")
    .select("id, link_token")
    .eq("reserva_id", reservaId);
  const links = (fnrhList ?? []).map(
    (r: { id: string; link_token: string }) =>
      `${baseUrl}/fnrh-preenchimento.html?v=2&guest_id=${encodeURIComponent(r.id)}&token=${encodeURIComponent(r.link_token)}`,
  );
  const linksText = links.length > 0
    ? links.map((url: string, i: number) => `${i + 1}. ${url}`).join("\n")
    : "(nenhum link FNRH)";

  const r = reserva as { apartamento?: string };
  const msg = `Olá, sua reserva está pronta.\n\n🔐 Senha de acesso: ${passcode}\n\nPara agilizar seu check-in, preencha seus dados:\n${linksText}`;
  const html = `
    <p>Olá, sua reserva está pronta.</p>
    <p><strong>🔐 Senha de acesso: ${String(passcode).replace(/</g, "&lt;")}</strong></p>
    <p>Para agilizar seu check-in${r.apartamento ? ` no apartamento ${String(r.apartamento).replace(/</g, "&lt;")}` : ""}, preencha seus dados pelos links abaixo:</p>
    <ul>${links.map((url: string) => `<li><a href="${url}">Abrir formulário FNRH</a></li>`).join("")}</ul>
    ${links.length === 0 ? "<p>(Nenhum link FNRH pendente.)</p>" : ""}
    <p>Obrigado!</p>
  `;

  const now = new Date().toISOString();
  let enviado = false;
  let enviadoEmail = false;
  let enviadoWhatsapp = false;
  let erroEmail: string | null = null;
  let erroWhatsapp: string | null = null;
  let hospedeIdEnvio =
    principal && typeof (principal as { id?: string }).id === "string"
      ? (principal as { id: string }).id
      : "";
  if (!hospedeIdEnvio) {
    const { data: umHospede } = await admin
      .from("operacional_hospedes")
      .select("id")
      .eq("reserva_id", reservaId)
      .limit(1)
      .maybeSingle();
    if (umHospede?.id) hospedeIdEnvio = String(umHospede.id);
  }

  if (emailTo) {
    const result = await sendEmail(
      emailTo,
      "Sua senha de acesso — " + (r.apartamento || "reserva"),
      html,
    );
    if (result.ok) {
      enviado = true;
      enviadoEmail = true;
      await registrarOperacionalComunicacaoEnvio(admin, {
        reserva_id: reservaId,
        conversa_id: null,
        hospede_id: hospedeIdEnvio || null,
        proposito: "senha_acesso",
        canal: "email",
        destinatario_mascara: maskEmailForLog(emailTo),
        corpo_preview: previewCorpo(msg),
        status: "enviada",
        provider: "resend",
        provider_message_id: null,
        metadata: { manual: isManual },
        erro: null,
      });
    } else erroEmail = result.error ?? "Falha ao enviar e-mail.";
  }

  if (!enviado && whatsappTo) {
    if (!hospedeIdEnvio) {
      erroWhatsapp = "Inclua ao menos um hóspede na reserva para registrar envio por WhatsApp.";
    } else {
      const wResult = await outboundWhatsappTransacional(admin, {
        reservaId,
        hospedeId: hospedeIdEnvio,
        telefoneRaw: whatsappTo,
        text: msg,
        proposito: "senha_acesso",
      });
      if (wResult.ok) {
        enviado = true;
        enviadoWhatsapp = true;
      } else {
        erroWhatsapp = wResult.error ?? "Falha ao enviar WhatsApp (DigiSac).";
      }
    }
  }

  if (!enviado) {
    let mensagemErro: string;
    if (emailTo && whatsappTo) {
      mensagemErro = [erroEmail, erroWhatsapp].filter(Boolean).join(" · ") || "Nenhum canal conseguiu entregar.";
    } else if (emailTo) {
      mensagemErro = erroEmail ?? "E-mail não enviado.";
    } else if (whatsappTo) {
      mensagemErro = erroWhatsapp ??
        "WhatsApp não enviado (verifique DigiSac ou use e-mail com RESEND_API_KEY).";
    } else {
      mensagemErro = "Nenhum envio realizado.";
    }
    return jsonResponse(
      {
        ok: false,
        error: mensagemErro,
        reserva_id: reservaId,
        enviado_email: false,
        enviado_whatsapp: false,
      },
      400,
    );
  }

  const alreadySent = (reserva as { senha_enviada_em?: string | null }).senha_enviada_em;
  await admin
    .from("operacional_reservas")
    .update({
      ...(alreadySent ? {} : { senha_enviada_em: now }),
      updated_at: now,
    })
    .eq("id", reservaId);

  await admin.from("operacional_reserva_eventos").insert({
    reserva_id: reservaId,
    tipo: isManual ? "envio_manual_senha" : "envio_auto_senha",
    titulo: isManual ? "Envio manual de senha" : "Envio automático de senha",
    detalhe: JSON.stringify({
      usuario_id: usuarioId || null,
      canais: { email: enviadoEmail, whatsapp: enviadoWhatsapp },
      canal_operacional_whatsapp: enviadoWhatsapp ? "digisac" : null,
      qtd_fnrh_links: links.length,
      timestamp: now,
    }),
  });

  const msgOk = enviadoWhatsapp
    ? "Senha e links enviados por WhatsApp (DigiSac)."
    : "Senha e links enviados por e-mail.";

  return jsonResponse(
    {
      ok: true,
      message: msgOk,
      reserva_id: reservaId,
      enviado_email: enviadoEmail,
      enviado_whatsapp: enviadoWhatsapp,
    },
    200,
  );
});
