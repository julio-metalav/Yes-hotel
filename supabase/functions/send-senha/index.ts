/**
 * Envio de senha TTLock + links FNRH (manual ou automático).
 * POST: { reserva_id, manual?: boolean, usuario_id?: string, email?: string, whatsapp?: string }.
 * Se manual e email/whatsapp informados, salva nos contatos do hóspede principal.
 * Mensagem: "Olá, sua reserva está pronta. 🔐 Senha de acesso: {senha}. Para agilizar seu check-in, preencha seus dados: {links}"
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
    .select("hospede_id, link_token")
    .eq("reserva_id", reservaId);
  const links = (fnrhList ?? []).map(
    (r: { hospede_id: string; link_token: string }) =>
      `${baseUrl}/fnrh-preenchimento.html?guest_id=${encodeURIComponent(r.hospede_id)}&token=${encodeURIComponent(r.link_token)}`,
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
  let erroEmail: string | null = null;

  if (emailTo) {
    const result = await sendEmail(
      emailTo,
      "Sua senha de acesso — " + (r.apartamento || "reserva"),
      html,
    );
    if (result.ok) enviado = true;
    else erroEmail = result.error ?? "Falha ao enviar e-mail.";
  }

  if (whatsappTo && !enviado) {
    console.warn(
      "[send-senha] WhatsApp automático inativo (DigiSac/manual); número informado mas sem envio pelo Yes:",
      whatsappTo,
    );
  }

  if (!enviado) {
    let mensagemErro: string;
    if (emailTo) {
      mensagemErro = erroEmail ?? "E-mail não enviado.";
    } else if (whatsappTo) {
      mensagemErro =
        "Sem e-mail para envio automático. WhatsApp pelo Yes não está ativo (use e-mail com RESEND_API_KEY ou envie manualmente pela DigiSac).";
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
      canais: { email: true, whatsapp: false },
      qtd_fnrh_links: links.length,
      timestamp: now,
    }),
  });

  return jsonResponse(
    {
      ok: true,
      message: "Senha e links enviados por e-mail.",
      reserva_id: reservaId,
      enviado_email: true,
      enviado_whatsapp: false,
    },
    200,
  );
});
