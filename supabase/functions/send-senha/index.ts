/**
 * Envio de senha TTLock + links FNRH (manual ou automático).
 * Multicanal ao hóspede: e-mail (Resend) e WhatsApp (DigiSac) são tentados
 * de forma independente quando ambos os contatos existem. Mesma senha/links.
 * POST: {
 *   reserva_id, manual?: boolean, usuario_id?: string, email?: string, whatsapp?: string,
 *   origem?: string, gerar_nova?: boolean, confirmacao_gerar_nova?: boolean
 * }.
 * Se gerar_nova=true: revoga/substitui a senha via lifecycle_gerar_nova_senha e só então envia.
 * Reenvio (sem gerar_nova) reutiliza a credencial existente.
 */
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  aggregateGuestChannelResults,
  planGuestChannels,
  type GuestChannelAttempt,
} from "../_shared/comunicacao-operacional/guest-multichannel.ts";
import { outboundWhatsappTransacional } from "../_shared/comunicacao-operacional/outbound-whatsapp.ts";
import { maskEmailForLog, previewCorpo, registrarOperacionalComunicacaoEnvio } from "../_shared/comunicacao-operacional/registro-envio.ts";
import { formatTtlockPasscodeForGuest } from "../_shared/ttlock-credential-format.ts";
import {
  buildGuestAccessReadyMessage,
  formatCheckinDateLabelPtBr,
  guestFirstName,
  isBeforeCheckinActivationHour,
  resolveParkingSpot,
} from "../../../src/lib/domain/yes-hotel/guest-access-messages.ts";
import {
  evaluateTtlockReadyForGuestAccess,
  isLifecycleProvisionAccessReady,
} from "../../../src/lib/domain/yes-hotel/ttlock-guest-access-gate.ts";

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

const gerarNovaInFlight = new Set<string>();

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Método não permitido." }, 405);

  let body: {
    reserva_id?: string;
    manual?: boolean;
    usuario_id?: string;
    email?: string;
    whatsapp?: string;
    origem?: string;
    gerar_nova?: boolean;
    confirmacao_gerar_nova?: boolean;
    acao?: string;
  };
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
  const origemRegistro = (body as { origem?: string }).origem?.trim() || (isManual ? "manual" : "requisitos");
  const gerarNova =
    !!body.gerar_nova ||
    String(body.acao || "").trim() === "gerar_nova";
  const confirmacaoGerarNova = !!body.confirmacao_gerar_nova;

  const { data: reserva, error: errR } = await admin
    .from("operacional_reservas")
    .select("id, apartamento, hospede_principal, check_in_previsto, senha_enviada_em")
    .eq("id", reservaId)
    .maybeSingle();
  if (errR || !reserva) return jsonResponse({ ok: false, error: "Reserva não encontrada." }, 404);

  const alreadySentAtStart = (reserva as { senha_enviada_em?: string | null }).senha_enviada_em;
  // Idempotência automática: nunca reenviar sozinho se já houve envio registrado.
  if (!isManual && !gerarNova && alreadySentAtStart) {
    return jsonResponse({
      ok: true,
      skipped: true,
      reason: "ja_enviada",
      message: "Senha já enviada anteriormente; envio automático ignorado.",
      reserva_id: reservaId,
    }, 200);
  }

  if (gerarNova && !confirmacaoGerarNova) {
    return jsonResponse({
      ok: false,
      error: "Confirmação obrigatória para gerar nova senha.",
    }, 400);
  }

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

  let passcodeAnterior: string | null = null;
  const authHeader = req.headers.get("Authorization") ?? "";
  const lifecycleUrl = `${supabaseUrl}/functions/v1/yes-hotel-lifecycle`;
  const credencialId = String((credencial as { id: string }).id);

  async function loadReadyGate() {
    const { data: cred } = await admin
      .from("operacional_credenciais_acesso")
      .select("id, codigo_credencial, status")
      .eq("id", credencialId)
      .maybeSingle();
    const { data: itens } = await admin
      .from("operacional_credencial_itens")
      .select("status_provisionamento, remote_keyboard_pwd_id")
      .eq("credencial_id", credencialId);
    return evaluateTtlockReadyForGuestAccess(
      cred as { status: string; codigo_credencial: string | null } | null,
      (itens ?? []) as { status_provisionamento: string; remote_keyboard_pwd_id: number | null }[],
    );
  }

  async function blockGuestAccessReady(motivo: string, detalheExtra?: Record<string, unknown>) {
    await admin.from("operacional_reserva_eventos").insert({
      reserva_id: reservaId,
      tipo: "falha_enviar_credenciais",
      titulo: "Envio guest_access_ready bloqueado — TTLock não confirmado",
      detalhe: JSON.stringify({
        origem: origemRegistro,
        motivo,
        ...(detalheExtra ?? {}),
        timestamp: new Date().toISOString(),
      }),
    });
    return jsonResponse({
      ok: false,
      error:
        "Acesso TTLock não confirmado nos locks obrigatórios. Nenhuma mensagem foi enviada. Tente provisionar novamente.",
      motivo,
      reserva_id: reservaId,
    }, 409);
  }

  if (gerarNova) {
    if (gerarNovaInFlight.has(reservaId)) {
      return jsonResponse({
        ok: false,
        error: "Geração de nova senha já em andamento para esta reserva.",
        em_andamento: true,
      }, 409);
    }
    gerarNovaInFlight.add(reservaId);
    try {
      const genRes = await fetch(lifecycleUrl, {
        method: "POST",
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({
          action: "lifecycle_gerar_nova_senha",
          payload: {
            reservaId,
            usuario_id: usuarioId || null,
            motivo: origemRegistro || "gerar_nova_senha",
          },
        }),
      });
      const genData = (await genRes.json().catch(() => ({}))) as {
        ok?: boolean;
        passcode?: string;
        passcodeAnterior?: string | null;
        error?: string;
        limpezaPendente?: number;
        bloqueadoPorLimpeza?: boolean;
        em_andamento?: boolean;
      };
      if (!genRes.ok || !genData.ok || !genData.passcode) {
        await admin.from("operacional_reserva_eventos").insert({
          reserva_id: reservaId,
          tipo: "gerar_nova_senha_envio_bloqueado",
          titulo: "Gerar nova senha: envio não realizado",
          detalhe: JSON.stringify({
            usuario_id: usuarioId || null,
            origem: origemRegistro,
            erro: genData.error || null,
            limpeza_pendente: genData.limpezaPendente ?? null,
            bloqueado_por_limpeza: !!genData.bloqueadoPorLimpeza,
            timestamp: new Date().toISOString(),
          }),
        });
        return jsonResponse({
          ok: false,
          error: genData.error ?? "Falha ao gerar nova senha. Nenhuma mensagem foi enviada.",
          limpeza_pendente: genData.limpezaPendente ?? null,
          bloqueado_por_limpeza: !!genData.bloqueadoPorLimpeza,
        }, genRes.status === 409 ? 409 : 400);
      }
      passcodeAnterior = genData.passcodeAnterior ?? null;
    } finally {
      gerarNovaInFlight.delete(reservaId);
    }
  } else {
    let gatePre = await loadReadyGate();
    if (!gatePre.ready) {
      // Sempre service_role + header interno: lifecycle_provision exige operador JWT
      // no caminho manual; no automático (requisitos/Pagar.me) não há sessão de operador.
      async function callLifecycleProvision() {
        const provisionRes = await fetch(lifecycleUrl, {
          method: "POST",
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceRoleKey}`,
            "x-yes-internal-caller": "send-senha",
          },
          body: JSON.stringify({ action: "lifecycle_provision", payload: { reservaId } }),
        });
        return {
          res: provisionRes,
          data: (await provisionRes.json().catch(() => ({}))) as {
            ok?: boolean;
            passcode?: string;
            error?: string;
            status?: string;
            falhas?: number;
          },
        };
      }
      const first = await callLifecycleProvision();
      if (!isLifecycleProvisionAccessReady(first.data)) {
        return await blockGuestAccessReady(
          first.data.error
            ? "lifecycle_provision_falhou"
            : "lifecycle_provision_nao_confirmado",
          {
            lifecycle_status: first.data.status ?? null,
            lifecycle_error: first.data.error ?? null,
            falhas: first.data.falhas ?? null,
          },
        );
      }
      gatePre = await loadReadyGate();
      // Heal: lifecycle já confirmou 3/3 mas o status da credencial pode ter
      // ficado preso em provisionando se sync_* falhou. Reentrada idempotente.
      if (!gatePre.ready && String(gatePre.reason ?? "").startsWith("status_")) {
        await callLifecycleProvision();
        gatePre = await loadReadyGate();
      }
    }
  }

  const gate = await loadReadyGate();
  if (!gate.ready || !gate.passcode) {
    return await blockGuestAccessReady(gate.reason ?? "ttlock_nao_pronto");
  }
  const passcode = gate.passcode;

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

  const r = reserva as {
    apartamento?: string;
    hospede_principal?: string;
    check_in_previsto?: string;
  };
  // PIN técnico (passcode) permanece sem "#"; apresentação ao hóspede inclui # só como instrução.
  // Mensagem canônica guest_access_ready — só após gate TTLock 3/3.

  const apt = String(r.apartamento ?? "").trim();
  const checkin = r.check_in_previsto
    ? `${String(r.check_in_previsto).slice(0, 10)}T13:00:00-04:00`
    : new Date().toISOString();
  const nowDt = new Date();
  const checkinLabel = formatCheckinDateLabelPtBr(checkin);
  const stayNote = alreadySentAtStart
    ? `Use esta senha de acesso para sua hospedagem de ${checkinLabel.slice(0, 5)}.`
    : null;
  const accessMsg = buildGuestAccessReadyMessage({
    guest_first_name: guestFirstName(r.hospede_principal),
    apartment_number: apt || "—",
    passcode: String(passcode),
    parking_spot: resolveParkingSpot({ apartment_number: apt }),
    checkin_date_label: checkinLabel,
    before_activation: isBeforeCheckinActivationHour(checkin, nowDt),
    stay_access_note: stayNote,
  });
  // Garante helper de formatação carregado (evita tree-shake acidental em Deno).
  void formatTtlockPasscodeForGuest;
  const msg = accessMsg.body;
  const html = accessMsg.body_html;

  const now = new Date().toISOString();
  // Mesma senha (passcode) + mesmos links FNRH nos dois canais — sem duplicar recurso.

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

  const plan = planGuestChannels(emailTo, whatsappTo, "hospede");
  let emailAttempt: GuestChannelAttempt | null = null;
  let whatsappAttempt: GuestChannelAttempt | null = null;
  let erroEmail: string | null = null;
  let erroWhatsapp: string | null = null;

  if (plan.tryEmail) {
    const result = await sendEmail(
      emailTo,
      "Sua senha de acesso — " + (r.apartamento || "reserva"),
      html,
    );
    if (result.ok) {
      emailAttempt = { status: "enviado" };
      await registrarOperacionalComunicacaoEnvio(admin, {
        reserva_id: reservaId,
        conversa_id: null,
        hospede_id: hospedeIdEnvio || null,
        proposito: "guest_access_ready",
        canal: "email",
        destinatario_mascara: maskEmailForLog(emailTo),
        corpo_preview: previewCorpo(msg),
        status: "enviada",
        provider: "resend",
        provider_message_id: null,
        metadata: { manual: isManual, multicanal_hospede: true },
        erro: null,
      });
    } else {
      erroEmail = result.error ?? "Falha ao enviar e-mail.";
      emailAttempt = { status: "falhou", error: erroEmail };
      await registrarOperacionalComunicacaoEnvio(admin, {
        reserva_id: reservaId,
        conversa_id: null,
        hospede_id: hospedeIdEnvio || null,
        proposito: "guest_access_ready",
        canal: "email",
        destinatario_mascara: maskEmailForLog(emailTo),
        corpo_preview: previewCorpo(msg),
        status: "falha",
        provider: "resend",
        provider_message_id: null,
        metadata: { manual: isManual, multicanal_hospede: true },
        erro: erroEmail,
      });
    }
  } else {
    emailAttempt = { status: "indisponivel" };
  }

  // Independente do e-mail: sempre tenta WhatsApp se contato válido (mesma senha).
  if (plan.tryWhatsapp) {
    if (!hospedeIdEnvio) {
      erroWhatsapp = "Inclua ao menos um hóspede na reserva para registrar envio por WhatsApp.";
      whatsappAttempt = { status: "falhou", error: erroWhatsapp };
    } else {
      const wResult = await outboundWhatsappTransacional(admin, {
        reservaId,
        hospedeId: hospedeIdEnvio,
        telefoneRaw: whatsappTo,
        text: msg,
        proposito: "guest_access_ready",
      });
      if (wResult.ok) {
        whatsappAttempt = { status: "enviado" };
      } else {
        erroWhatsapp = wResult.error ?? "Falha ao enviar WhatsApp (DigiSac).";
        whatsappAttempt = { status: "falhou", error: erroWhatsapp };
      }
    }
  } else {
    whatsappAttempt = { status: "indisponivel" };
  }

  const agg = aggregateGuestChannelResults(emailAttempt, whatsappAttempt);
  const enviadoEmail = agg.emailOk;
  const enviadoWhatsapp = agg.whatsappOk;

  if (!agg.delivered) {
    let mensagemErro: string;
    if (plan.tryEmail && plan.tryWhatsapp) {
      mensagemErro = [erroEmail, erroWhatsapp].filter(Boolean).join(" · ") || "Nenhum canal conseguiu entregar.";
    } else if (plan.tryEmail) {
      mensagemErro = erroEmail ?? "E-mail não enviado.";
    } else if (plan.tryWhatsapp) {
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
        email_status: agg.email,
        whatsapp_status: agg.whatsapp,
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

  if (hospedeIdEnvio && agg.ultimoEnvioCanal) {
    await admin.from("operacional_hospedes").update({
      ultimo_envio_canal: agg.ultimoEnvioCanal,
      ultimo_envio_em: now,
      updated_at: now,
    }).eq("id", hospedeIdEnvio);
  }

  await admin.from("operacional_reserva_eventos").insert({
    reserva_id: reservaId,
    tipo: gerarNova
      ? "envio_nova_senha"
      : isManual
        ? "envio_manual_senha"
        : "envio_auto_senha",
    titulo: gerarNova
      ? "Envio de nova senha"
      : isManual
        ? "Envio manual de senha"
        : "Envio automático de senha",
    detalhe: JSON.stringify({
      usuario_id: usuarioId || null,
      origem: origemRegistro,
      gerar_nova: gerarNova,
      passcode_anterior_substituido: gerarNova ? !!passcodeAnterior : false,
      canais: { email: enviadoEmail, whatsapp: enviadoWhatsapp },
      email_status: agg.email,
      whatsapp_status: agg.whatsapp,
      canal_operacional_whatsapp: enviadoWhatsapp ? "digisac" : null,
      multicanal_hospede: true,
      qtd_fnrh_links: 0,
      timestamp: now,
    }),
  });

  const msgOk = gerarNova
    ? (enviadoEmail && enviadoWhatsapp
      ? "Nova senha gerada e enviada por e-mail e WhatsApp."
      : enviadoWhatsapp
        ? "Nova senha gerada e enviada por WhatsApp (DigiSac)."
        : "Nova senha gerada e enviada por e-mail.")
    : enviadoEmail && enviadoWhatsapp
      ? "Senha e links enviados por e-mail e WhatsApp."
      : enviadoWhatsapp
        ? "Senha e links enviados por WhatsApp (DigiSac)."
        : "Senha e links enviados por e-mail.";

  return jsonResponse(
    {
      ok: true,
      message: msgOk,
      reserva_id: reservaId,
      enviado_email: enviadoEmail,
      enviado_whatsapp: enviadoWhatsapp,
      email_status: agg.email,
      whatsapp_status: agg.whatsapp,
      gerar_nova: gerarNova,
    },
    200,
  );
});
