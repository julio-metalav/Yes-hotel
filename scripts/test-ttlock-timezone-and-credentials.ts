import assert from "node:assert/strict";
import {
  buildProvisionPlan,
  calculateCredentialWindow,
  hotelLocalToUtcIso,
  hotelLocalToUtcMs,
  resolveDefaultCredentialValidityIso,
  validityIsoToTtlockMs,
  YES_HOTEL_TIMEZONE,
  deriveTtlockPasscodeFromReservation,
  formatTtlockPasscodeForGuest,
  normalizeTechnicalTtlockPasscode,
} from "../src/lib/domain/yes-hotel";
import {
  formatTtlockPasscodeForGuest as edgeFormatGuest,
  normalizeTechnicalTtlockPasscode as edgeNormalize,
} from "../supabase/functions/_shared/ttlock-credential-format.ts";
import {
  hotelLocalToUtcIso as edgeHotelLocalToUtcIso,
  resolveDefaultCredentialValidityIso as edgeResolveValidity,
  validityIsoToTtlockMs as edgeValidityToMs,
} from "../supabase/functions/_shared/hotel-timezone.ts";

// --- Horários Campo Grande ---
{
  assert.equal(YES_HOTEL_TIMEZONE, "America/Campo_Grande");
  const startIso = hotelLocalToUtcIso("2026-08-08", 13, 0);
  const endIso = hotelLocalToUtcIso("2026-08-10", 11, 0);
  assert.equal(startIso, "2026-08-08T17:00:00.000Z");
  assert.equal(endIso, "2026-08-10T15:00:00.000Z");

  // Sem deslocamento errado de -4h (não pode ser 13:00Z / 11:00Z)
  assert.notEqual(startIso, "2026-08-08T13:00:00.000Z");
  assert.notEqual(endIso, "2026-08-10T11:00:00.000Z");

  const { startDateMs, endDateMs } = validityIsoToTtlockMs(startIso, endIso);
  assert.equal(startDateMs, Date.parse("2026-08-08T17:00:00.000Z"));
  assert.equal(endDateMs, Date.parse("2026-08-10T15:00:00.000Z"));
  // API TTLock: milissegundos (não segundos)
  assert.ok(startDateMs > 1e12);
  assert.ok(endDateMs > 1e12);

  const win = resolveDefaultCredentialValidityIso("2026-08-08", "2026-08-10");
  assert.equal(win.valido_de, startIso);
  assert.equal(win.valido_ate, endIso);
}

// atravessar meia-noite (checkout no dia seguinte às 11h)
{
  const win = resolveDefaultCredentialValidityIso("2026-08-08", "2026-08-09");
  assert.equal(win.valido_de, "2026-08-08T17:00:00.000Z");
  assert.equal(win.valido_ate, "2026-08-09T15:00:00.000Z");
  assert.ok(Date.parse(win.valido_ate) > Date.parse(win.valido_de));
}

// access-engine usa o mesmo fuso (não setHours do runtime)
{
  const window = calculateCredentialWindow({
    reservationId: "r1",
    guestMainName: "Teste",
    apartmentCode: "10",
    checkIn: "2026-08-08",
    checkOut: "2026-08-10",
    status: "confirmed",
  });
  assert.equal(window.validFrom.toISOString(), "2026-08-08T17:00:00.000Z");
  assert.equal(window.validTo.toISOString(), "2026-08-10T15:00:00.000Z");
  assert.equal(window.source, "default");

  const plan = buildProvisionPlan({
    reservationId: "r1",
    guestMainName: "Teste",
    apartmentCode: "10",
    checkIn: "2026-08-08",
    checkOut: "2026-08-10",
    status: "confirmed",
  });
  assert.equal(plan.window.validFrom.toISOString(), "2026-08-08T17:00:00.000Z");
}

// domínio e Edge idênticos
{
  const a = resolveDefaultCredentialValidityIso("2026-08-08", "2026-08-10");
  const b = edgeResolveValidity("2026-08-08", "2026-08-10");
  assert.deepEqual(a, b);
  assert.equal(hotelLocalToUtcIso("2026-08-08", 13), edgeHotelLocalToUtcIso("2026-08-08", 13));
  assert.deepEqual(
    validityIsoToTtlockMs(a.valido_de, a.valido_ate),
    edgeValidityToMs(b.valido_de, b.valido_ate),
  );
  assert.equal(hotelLocalToUtcMs("2026-08-08", 13), Date.parse("2026-08-08T17:00:00.000Z"));
}

// Payload anterior (bug) vs corrigido — sem senha
{
  const buggyStart = Date.parse("2026-08-08T13:00:00.000Z"); // exibia 09:00 no app CG
  const buggyEnd = Date.parse("2026-08-10T11:00:00.000Z"); // exibia 07:00
  const fixed = validityIsoToTtlockMs(
    "2026-08-08T17:00:00.000Z",
    "2026-08-10T15:00:00.000Z",
  );
  assert.equal(fixed.startDateMs - buggyStart, 4 * 60 * 60 * 1000);
  assert.equal(fixed.endDateMs - buggyEnd, 4 * 60 * 60 * 1000);
}

// --- Regras de credenciais (comportamento documentado / mocks) ---
type Cred = {
  reservaId: string;
  status: "provisionada" | "revogada" | "pendente";
  remoteIds: number[];
};

function reenviarSenha(cred: Cred): { cria: boolean; revoga: boolean; reutiliza: boolean } {
  // send-senha sem gerar_nova: só lê passcode existente
  if (cred.status === "revogada" || cred.remoteIds.length === 0) {
    return { cria: false, revoga: false, reutiliza: false };
  }
  return { cria: false, revoga: false, reutiliza: true };
}

function provisionarIdempotente(cred: Cred, todosProvisionados: boolean): {
  criaNovoRemoto: boolean;
  idempotente: boolean;
} {
  if (todosProvisionados) return { criaNovoRemoto: false, idempotente: true };
  return { criaNovoRemoto: true, idempotente: false };
}

function gerarNova(
  cred: Cred,
  revokeOk: boolean,
): { revogaAnterior: boolean; criaNova: boolean; bloqueado: boolean } {
  if (!revokeOk) return { revogaAnterior: false, criaNova: false, bloqueado: true };
  return { revogaAnterior: true, criaNova: true, bloqueado: false };
}

function podeTocarCredencial(alvo: Cred, reservaAtual: string): boolean {
  return alvo.reservaId === reservaAtual;
}

function alertaConflitoSemVinculo(opts: {
  ativaNoApp: boolean;
  temRemoteIdNoBanco: boolean;
  mesmaReserva: boolean;
}): "ignorar" | "revogar_vinculada" | "alerta_manual" {
  if (!opts.ativaNoApp) return "ignorar";
  if (opts.temRemoteIdNoBanco && opts.mesmaReserva) return "revogar_vinculada";
  if (opts.ativaNoApp && !opts.temRemoteIdNoBanco) return "alerta_manual";
  return "ignorar";
}

{
  const cred: Cred = {
    reservaId: "5321a46f-5000-43e1-8830-df57f3bc0439",
    status: "provisionada",
    remoteIds: [101, 102],
  };
  assert.deepEqual(reenviarSenha(cred), { cria: false, revoga: false, reutiliza: true });
  assert.deepEqual(provisionarIdempotente(cred, true), {
    criaNovoRemoto: false,
    idempotente: true,
  });
  assert.deepEqual(gerarNova(cred, true), {
    revogaAnterior: true,
    criaNova: true,
    bloqueado: false,
  });
  assert.deepEqual(gerarNova(cred, false), {
    revogaAnterior: false,
    criaNova: false,
    bloqueado: true,
  });

  const outra: Cred = { reservaId: "outra", status: "provisionada", remoteIds: [999] };
  assert.equal(podeTocarCredencial(outra, cred.reservaId), false);
  assert.equal(podeTocarCredencial(cred, cred.reservaId), true);

  assert.equal(
    alertaConflitoSemVinculo({
      ativaNoApp: false,
      temRemoteIdNoBanco: false,
      mesmaReserva: false,
    }),
    "ignorar",
  );
  assert.equal(
    alertaConflitoSemVinculo({
      ativaNoApp: true,
      temRemoteIdNoBanco: true,
      mesmaReserva: true,
    }),
    "revogar_vinculada",
  );
  assert.equal(
    alertaConflitoSemVinculo({
      ativaNoApp: true,
      temRemoteIdNoBanco: false,
      mesmaReserva: false,
    }),
    "alerta_manual",
  );
}

// --- Apresentação ao hóspede: PIN técnico vs instrução com # ---
{
  const pin = "1134";
  const guest = formatTtlockPasscodeForGuest(pin);
  assert.equal(guest.technical, "1134");
  assert.equal(guest.displayWithHash, "1134#");
  assert.equal(guest.instructionLine, "(digite 1134 + #)");
  assert.match(guest.guestBlock, /^Senha do apartamento: 1134#/);
  assert.match(guest.guestBlock, /\(digite 1134 \+ #\)/);
  assert.match(guest.guestBlock, /portões do bloco/);
  assert.match(guest.guestBlockHtml, /1134#/);
  assert.match(guest.guestBlockHtml, /\(digite 1134 \+ #\)/);

  // "#" na entrada do hóspede não vira PIN técnico
  assert.equal(normalizeTechnicalTtlockPasscode("1134#"), "1134");
  assert.equal(formatTtlockPasscodeForGuest("1134#").technical, "1134");
  assert.equal(formatTtlockPasscodeForGuest("1134#").displayWithHash, "1134#");

  // Domínio e Edge alinhados (mesmo texto e-mail/WhatsApp)
  const edge = edgeFormatGuest("1134");
  assert.equal(edge.guestBlock, guest.guestBlock);
  assert.equal(edge.guestBlockHtml, guest.guestBlockHtml);
  assert.equal(edgeNormalize("1134#"), "1134");

  // Legado (deprecated): derivação ainda 4 dígitos; provisionamento novo usa PIN aleatório.
  const derived = deriveTtlockPasscodeFromReservation("HITS-FAKE-E2E-20260811-BRENO-APT34", "80a2d708-5bcc-4af3-856d-505f234055e0");
  assert.equal(derived.length, 4);
  assert.equal(/\D/.test(derived), false);
  assert.equal(formatTtlockPasscodeForGuest(derived).technical, derived);
  assert.equal(formatTtlockPasscodeForGuest(derived).displayWithHash, `${derived}#`);
}

console.log("ok: test-ttlock-timezone-and-credentials");
