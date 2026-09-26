/**
 * Boas-vindas do primeiro acesso: entrega garantida e uma unica vez.
 *
 * Bug em PROD: o hospede abria a fechadura, o acesso era detectado, e a
 * mensagem de boas-vindas nao chegava.
 *
 * Causa: a RPC devolve `already_started` quando `entrou_no_apto` ja estava
 * true, mesmo sendo este o primeiro acesso processado. Os dois guards do
 * orquestrador exigiam `processed_no_pending` ou `grace_started`, entao a
 * boas-vindas era pulada em silencio.
 *
 * A correcao aceita `already_started` nos dois ramos. Isso so e seguro porque
 * a chave de idempotencia da boas-vindas e por RESERVA e o outbox faz upsert
 * com ignoreDuplicates -- reprocessar nunca gera segunda mensagem. Este teste
 * prova as duas coisas juntas: a mensagem sai, e sai uma vez so.
 */
import assert from "node:assert/strict";

import { processFirstRoomAccessEvent } from "../src/lib/application/yes-hotel/first-room-access-orchestrator";
import { createFirstRoomAccessMemoryHarness } from "../src/lib/application/yes-hotel/testing/first-room-access-memory";
import { ACCESS_EVENT_SOURCE_POLLING } from "../src/lib/integrations/ttlock/access-ingest/constants";
import { guestFirstAccessWelcomeIdempotencyKey } from "../src/lib/domain/yes-hotel/guest-access-messages";

function ok(label: string) {
  console.log("  OK  " + label);
}

const RESERVA = "res-boas-vindas";
const LOCK_APT = 16274746;

function threeItems() {
  return [
    {
      id: "item-apt", credential_id: "cred-1", logical_destination: "APT-34",
      lock_id: LOCK_APT, remote_keyboard_pwd_id: 11, lock_type: "apartamento" as const,
      status_provisionamento: "provisionado" as const,
    },
    {
      id: "item-ext", credential_id: "cred-1", logical_destination: "GATE-A-EXTERNAL",
      lock_id: 10939258, remote_keyboard_pwd_id: 12, lock_type: "portao_externo" as const,
      status_provisionamento: "provisionado" as const,
    },
    {
      id: "item-int", credential_id: "cred-1", logical_destination: "GATE-A-INTERNAL",
      lock_id: 10939408, remote_keyboard_pwd_id: 13, lock_type: "portao_interno" as const,
      status_provisionamento: "provisionado" as const,
    },
  ];
}

function harness(opts: { pago: boolean; fnrhCompleta: boolean }) {
  const h = createFirstRoomAccessMemoryHarness({
    correlation: {
      correlated: true,
      reservation_id: RESERVA,
      credential_id: "cred-1",
      credential_item_id: "item-apt",
      logical_destination: "APT-34",
      lock_type: "apartamento",
      within_reservation_window: true,
      keyboard_pwd_id: 11,
      original_valid_from: "2026-08-11T17:00:00.000Z",
      original_valid_until: "2026-08-12T15:00:00.000Z",
    },
    pending: {
      payment_status: opts.pago ? "pago" : "pendente",
      guests: [
        {
          id: "p1",
          role: "principal_adulto",
          fnrh_status: opts.fnrhCompleta ? "completed" : "pending",
        },
      ],
    },
    items: threeItems(),
    now: new Date("2026-08-11T23:20:00.000Z"),
  });
  h.ports.reservationDisplay = {
    async getContext() {
      return {
        apartment_number: "34",
        reservation_code: "HITS-1",
        guest_main_name: "Breno Santoriano",
        parking_spot: "34",
        wifi_ssid: "YES-34",
        wifi_password: "segredo34",
      };
    },
  };
  return h;
}

const evento = (idem: string) => ({
  source: ACCESS_EVENT_SOURCE_POLLING,
  source_event_id: "poll:" + idem,
  idempotency_key: idem,
  occurred_at: "2026-08-11T23:20:00.000Z",
  lock_id: LOCK_APT,
  record_type: 4,
  success: true,
});

const welcomes = (h: ReturnType<typeof harness>) =>
  h.state.accessOutbox.filter((o) => o.event_type === "guest_first_access_welcome");

async function main() {
  console.log("\n== Reprocessar o MESMO evento nao duplica ==");
  {
    const h = harness({ pago: true, fnrhCompleta: true });
    const r1 = await processFirstRoomAccessEvent(evento("mesmo-evento"), h.ports);
    assert.equal(r1.status, "processed_no_pending");
    assert.equal(welcomes(h).length, 2, "whatsapp + email na primeira passada");

    // Polling repetido entrega o mesmo registro fisico outra vez.
    const r2 = await processFirstRoomAccessEvent(evento("mesmo-evento"), h.ports);
    assert.equal(welcomes(h).length, 2, "segunda passada nao criou mensagem nova");
    void r2;
    ok("mesmo evento processado duas vezes: 1 boas-vindas por canal");
  }

  console.log("\n== Evento DIFERENTE na mesma reserva tambem nao duplica ==");
  {
    // Segunda abertura da porta, outro registro do TTLock, mesma reserva.
    const h = harness({ pago: true, fnrhCompleta: true });
    await processFirstRoomAccessEvent(evento("abertura-1"), h.ports);
    assert.equal(welcomes(h).length, 2);
    await processFirstRoomAccessEvent(evento("abertura-2"), h.ports);
    assert.equal(welcomes(h).length, 2, "segunda abertura nao gera nova boas-vindas");

    // A chave e por RESERVA, nao por evento: e isso que garante o resultado.
    const chaves = welcomes(h).map((o) => o.idempotency_key).sort();
    assert.deepEqual(chaves, [
      guestFirstAccessWelcomeIdempotencyKey(RESERVA, "whatsapp"),
      guestFirstAccessWelcomeIdempotencyKey(RESERVA, "email"),
    ].sort());
    ok("duas aberturas distintas: 1 boas-vindas por canal, chave por reserva");
  }

  console.log("\n== Com pendencia: boas-vindas E pendencia, sem duplicar ==");
  {
    const h = harness({ pago: false, fnrhCompleta: false });
    const r = await processFirstRoomAccessEvent(evento("com-pendencia"), h.ports);
    assert.equal(r.status, "grace_started");
    assert.equal(welcomes(h).length, 2, "boas-vindas sai mesmo com pendencia");
    assert.ok(
      h.state.accessOutbox.filter((o) => o.event_type === "guest_welcome_pending").length >= 1,
      "a mensagem de pendencia continua saindo",
    );

    await processFirstRoomAccessEvent(evento("com-pendencia"), h.ports);
    assert.equal(welcomes(h).length, 2, "replay nao duplicou a boas-vindas");
    ok("pendencia nao impede a boas-vindas, e replay nao duplica");
  }

  console.log("\n== Conteudo: Wi-Fi do apartamento certo ==");
  {
    const h = harness({ pago: true, fnrhCompleta: true });
    await processFirstRoomAccessEvent(evento("conteudo"), h.ports);
    const wa = welcomes(h).find((o) => o.channel === "whatsapp");
    const email = welcomes(h).find((o) => o.channel === "email");
    assert.ok(wa && email, "os dois canais foram enfileirados");
    const corpo = String(wa!.payload?.body ?? "");
    assert.match(corpo, /YES-34/, "rede do apartamento 34");
    assert.match(corpo, /segredo34/, "senha do apartamento 34");
    assert.match(corpo, /34/, "numero do apartamento");
    assert.match(corpo, /Breno/, "nome do hospede");
    ok("corpo traz Wi-Fi, apartamento e nome");
  }

  console.log("\n== Regressao: tolerancia, FNRH e pagamento intactos ==");
  {
    const h = harness({ pago: false, fnrhCompleta: false });
    const r = await processFirstRoomAccessEvent(evento("regressao"), h.ports);
    assert.equal(r.status, "grace_started");
    // A tolerancia de 1h continua sendo criada com o prazo de sempre.
    assert.equal(h.state.tolerances.length, 1);
    const tol = h.state.tolerances[0]!;
    assert.equal(tol.grace_status, "active");
    const inicio = Date.parse(tol.grace_started_at);
    const vence = Date.parse(tol.suspension_due_at);
    assert.equal(vence - inicio, 60 * 60 * 1000, "prazo segue sendo 1 hora");
    assert.equal(tol.pending_payment_at_start, true);
    assert.equal(tol.pending_fnrh_at_start, true);
    ok("tolerancia de 1h, pagamento e FNRH inalterados");
  }

  console.log("\n== Contrato do codigo ==");
  {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(
      resolve(process.cwd(), "src/lib/application/yes-hotel/first-room-access-orchestrator.ts"),
      "utf8",
    ).replace(/\r\n/g, "\n");

    // Os dois guards aceitam already_started: e a correcao do bug.
    assert.match(
      src,
      /noPending\.status === "processed_no_pending" \|\|\s*\n?\s*noPending\.status === "already_started"/,
      "ramo sem pendencia aceita already_started",
    );
    assert.match(
      src,
      /result\.status === "grace_started" \|\| result\.status === "already_started"/,
      "ramo com pendencia aceita already_started",
    );

    // A idempotencia continua vindo do outbox, sem solucao paralela.
    const enq = readFileSync(
      resolve(process.cwd(), "src/lib/application/yes-hotel/enqueue-guest-first-access-welcome.ts"),
      "utf8",
    );
    assert.match(enq, /guestFirstAccessWelcomeIdempotencyKey\(/);
    const queue = readFileSync(
      resolve(process.cwd(), "src/lib/infrastructure/supabase/yes-hotel/access-outbox-queue.ts"),
      "utf8",
    );
    assert.match(queue, /onConflict: "idempotency_key", ignoreDuplicates: true/);
    ok("guards corrigidos; idempotencia segue sendo a do outbox");
  }

  console.log("\nBoas-vindas do primeiro acesso: todos os testes passaram.\n");
}

async function testesTemplate() {
  const { renderizarTemplate, TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO } = await import(
    "../src/lib/domain/yes-hotel/mensagens-template"
  );

  console.log("\n== Template editado troca o texto enviado ==");
  {
    const h = harness({ pago: true, fnrhCompleta: true });
    h.ports.mensagensTemplates = {
      async carregar() {
        return "Oi {{hospede_nome}}, apto {{apartamento}}. Rede: {{wifi_rede}}.";
      },
    };
    await processFirstRoomAccessEvent(evento("com-template"), h.ports);
    const corpo = String(welcomes(h)[0]?.payload?.body ?? "");
    assert.match(corpo, /^Oi Breno Santoriano, apto 34\. Rede: YES-34\.$/);
    // O texto do codigo nao vaza junto.
    assert.doesNotMatch(corpo, /Estacionamento/);
    assert.equal(welcomes(h).length, 2, "os dois canais usam o mesmo texto");
    ok("texto editado substitui o do codigo nos dois canais");
  }

  console.log("\n== Fallback: template ausente, ilegivel ou vazio ==");
  {
    // a) porta ausente
    const a = harness({ pago: true, fnrhCompleta: true });
    await processFirstRoomAccessEvent(evento("sem-porta"), a.ports);
    assert.match(String(welcomes(a)[0]?.payload?.body ?? ""), /Seja bem-vindo ao Yes Hotel/);
    assert.match(String(welcomes(a)[0]?.payload?.body ?? ""), /Desejamos uma excelente estadia!/);
    assert.doesNotMatch(String(welcomes(a)[0]?.payload?.body ?? ""), /Estacionamento|portão|1 hora/);

    // b) leitura lanca
    const b = harness({ pago: true, fnrhCompleta: true });
    b.ports.mensagensTemplates = {
      async carregar() {
        throw new Error("banco fora do ar");
      },
    };
    const rb = await processFirstRoomAccessEvent(evento("template-quebrado"), b.ports);
    assert.notEqual(rb.status, "failed", "o primeiro acesso nao pode falhar por template");
    assert.equal(welcomes(b).length, 2, "a mensagem saiu mesmo assim");
    assert.match(String(welcomes(b)[0]?.payload?.body ?? ""), /Seja bem-vindo ao Yes Hotel/);

    // c) template vazio
    const c = harness({ pago: true, fnrhCompleta: true });
    c.ports.mensagensTemplates = { async carregar() { return "   "; } };
    await processFirstRoomAccessEvent(evento("template-vazio"), c.ports);
    assert.match(String(welcomes(c)[0]?.payload?.body ?? ""), /Seja bem-vindo ao Yes Hotel/);

    // d) template que renderiza vazio (so parametro ausente)
    const d = harness({ pago: true, fnrhCompleta: true });
    d.ports.mensagensTemplates = { async carregar() { return "{{wifi_rede}}"; } };
    d.ports.reservationDisplay = {
      async getContext() {
        return {
          apartment_number: "34", reservation_code: "HITS-1",
          guest_main_name: "Breno", parking_spot: "34",
          wifi_ssid: "", wifi_password: "",
        };
      },
    };
    await processFirstRoomAccessEvent(evento("render-vazio"), d.ports);
    assert.match(String(welcomes(d)[0]?.payload?.body ?? ""), /Seja bem-vindo ao Yes Hotel/);
    ok("porta ausente, erro de leitura, corpo vazio e render vazio caem no texto do codigo");
  }

  console.log("\n== Sem Wi-Fi: o bloco sai, nao sobra rotulo ==");
  {
    const h = harness({ pago: true, fnrhCompleta: true });
    h.ports.reservationDisplay = {
      async getContext() {
        return {
          apartment_number: "34", reservation_code: "HITS-1",
          guest_main_name: "Breno", parking_spot: "34",
          wifi_ssid: null, wifi_password: null,
          checkout_horario: "11h", telefone_recepcao: "(67) 99999-0000",
        };
      },
    };
    h.ports.mensagensTemplates = {
      async carregar() { return TEMPLATE_BOAS_VINDAS_PRIMEIRO_ACESSO; },
    };
    await processFirstRoomAccessEvent(evento("sem-wifi"), h.ports);
    const corpo = String(welcomes(h)[0]?.payload?.body ?? "");
    assert.doesNotMatch(corpo, /Wi-Fi:/);
    assert.doesNotMatch(corpo, /Rede:/);
    assert.doesNotMatch(corpo, /Senha:/);
    assert.match(corpo, /Apartamento: 34/);
    assert.match(corpo, /Check-out: 11h/);
    ok("apartamento sem Wi-Fi cadastrado nao recebe bloco quebrado");
  }

  console.log("\n== Idempotencia sobrevive ao template ==");
  {
    const h = harness({ pago: true, fnrhCompleta: true });
    h.ports.mensagensTemplates = { async carregar() { return "Oi {{hospede_nome}}."; } };
    await processFirstRoomAccessEvent(evento("idem-template"), h.ports);
    await processFirstRoomAccessEvent(evento("idem-template"), h.ports);
    await processFirstRoomAccessEvent(evento("idem-template-2"), h.ports);
    assert.equal(welcomes(h).length, 2, "reprocessar com template nao duplicou");
    ok("template nao afeta a idempotencia por reserva");
  }

  console.log("\n== Gatilho permanece no codigo ==");
  {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const mig = readFileSync(
      resolve(process.cwd(), "supabase/migrations/20261003090000_mensagens_automaticas_templates.sql"),
      "utf8",
    );
    const sem = mig.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    // A tabela guarda corpo e auditoria. Nada de gatilho, canal ou horario.
    for (const proibido of ["gatilho", "canal", "horario", "cron", "destinatario", "trigger_", "quando"]) {
      assert.doesNotMatch(sem, new RegExp("\b" + proibido + "\b", "i"), "migration expoe " + proibido);
    }
    // A RPC de escrita aceita exatamente dois argumentos: chave e corpo.
    assert.match(sem, /operacional_mensagens_salvar\(\s*\n?\s*p_chave text,\s*\n?\s*p_corpo text\s*\n?\)/);
    assert.match(sem, /mensagens_chave_desconhecida/, "chave nova exige codigo");
    ok("nao ha como alterar regra de disparo pela tela");
  }

  console.log("\nMensagens configuraveis: todos os testes passaram.\n");
}

main()
  .then(testesTemplate)
  .catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
  });
