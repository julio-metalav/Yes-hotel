/**
 * Testes: FNRH → DTO de PAX do gateway. Função pura, sem rede.
 *
 * O foco é o que NÃO é enviado: enum não confirmado e campo sem correspondência
 * ficam de fora, porque gravar errado no cadastro do hóspede é pior do que não
 * gravar.
 */
import assert from "node:assert/strict";
import {
  buildHitsGuestPutFromFnrh,
  hasUpdatableFields,
  normalizeEnumKey,
  type FnrhGuestData,
} from "../src/lib/integrations/hits/fnrh-to-hits-guest";

let cases = 0;
function ok(name: string) {
  cases += 1;
  console.log("  ok", name);
}

const FICHA_COMPLETA: FnrhGuestData = {
  hospede_nome: "Hospede Teste HITS",
  data_nascimento: "1985-04-17",
  documento_numero: "12345678909",
  documento_tipo: "CPF",
  telefone: "67999990000",
  email: "hospede.teste@example.com",
  sexo: "masculino",
  cep: "79002-010",
  logradouro: "Rua Teste",
  numero: "123",
  complemento: "Apto 07",
  bairro: "Centro",
  cidade: "Campo Grande",
  uf: "MS",
  pais: "Brasil",
  motivo_viagem: "lazer",
  meio_transporte: "carro",
  placa_veiculo: "ABC1D23",
  nacionalidade: "Brasileira",
};

function main() {
  console.log("\n== Campos diretos (sem enum) ==");
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 141501,
      idReservation: 17656,
      fnrh: FICHA_COMPLETA,
    });
    assert.equal(r.dto.idEntity, 141501);
    assert.equal(r.dto.idReservation, 17656);
    assert.equal(r.dto.name, "Hospede Teste HITS");
    assert.equal(r.dto.birthdate, "1985-04-17");
    assert.equal(r.dto.carLicensePlate, "ABC1D23");
    ok("identificadores, nome, nascimento e placa vão direto");

    const addr = (r.dto.addresses ?? [])[0]!;
    assert.deepEqual(addr, {
      address: "Rua Teste",
      number: "123",
      details: "Apto 07",
      neighborhood: "Centro",
      city: "Campo Grande",
      state: "MS",
      country: "Brasil",
      zipCode: "79002-010",
    });
    ok("endereço vira addresses[0] com as 8 chaves do contrato");
  }

  console.log("\n== Omissão por enum não confirmado ==");
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: FICHA_COMPLETA,
    });
    for (const campo of ["doc", "docType", "contact1", "contactType1", "contact2", "contactType2", "gender", "purposeTrip", "arrivingBy"]) {
      assert.equal((r.dto as Record<string, unknown>)[campo], undefined, `${campo} não pode ir sem de/para`);
    }
    ok("documento, contatos, sexo, motivo e transporte ficam de fora por padrão");

    const motivos = new Map(r.omitted.map((o) => [o.field, o.reason]));
    assert.equal(motivos.get("doc"), "enum_nao_confirmado");
    assert.equal(motivos.get("contact1"), "enum_nao_confirmado");
    assert.equal(motivos.get("nationalityCountryId"), "sem_campo_no_contrato");
    ok("cada omissão registra o motivo, sem expor valor");

    assert.equal(JSON.stringify(r.omitted).includes("12345678909"), false);
    assert.equal(JSON.stringify(r.included).includes("Hospede"), false);
    ok("diagnóstico não carrega PII — só nomes de campos");
  }
  {
    // Nacionalidade nunca é enviada enquanto for texto: o HITS quer id numérico.
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, nacionalidade: "Brasileira" },
    });
    assert.equal(r.dto.nationalityCountryId, undefined);
    ok("nacionalidade em texto nunca vira nationalityCountryId");
  }

  console.log("\n== Com o de/para confirmado (o dia seguinte à HITS) ==");
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: FICHA_COMPLETA,
      enums: {
        docType: { cpf: 2 },
        contactTypePhone: 1,
        contactTypeEmail: 2,
        gender: { masculino: 0 },
      },
    });
    assert.equal(r.dto.doc, "12345678909");
    assert.equal(r.dto.docType, 2);
    assert.equal(r.dto.contact1, "67999990000");
    assert.equal(r.dto.contactType1, 1);
    assert.equal(r.dto.contact2, "hospede.teste@example.com");
    assert.equal(r.dto.contactType2, 2);
    assert.equal(r.dto.gender, 0);
    ok("confirmado o de/para, os campos entram sem mudar a lógica");

    // purposeTrip/arrivingBy continuam fora: não foram confirmados neste mapa.
    assert.equal(r.dto.purposeTrip, undefined);
    assert.equal(r.dto.arrivingBy, undefined);
    ok("o que não está no de/para continua omitido, um a um");
  }
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, documento_tipo: "Passaporte" },
      enums: { docType: { cpf: 2 } },
    });
    assert.equal(r.dto.doc, undefined, "tipo fora do mapa não envia o número");
    ok("documento sem tipo mapeado não é enviado pela metade");
  }
  {
    assert.equal(normalizeEnumKey(" CPF "), "cpf");
    assert.equal(normalizeEnumKey("Passaporte"), "passaporte");
    assert.equal(normalizeEnumKey("Ônibus"), "onibus");
    ok("chave do de/para ignora caixa, acento e espaço");
  }

  console.log("\n== Ficha parcial e vazia ==");
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { hospede_nome: "  Só Nome  " },
    });
    assert.equal(r.dto.name, "Só Nome");
    assert.equal(r.dto.addresses, undefined);
    assert.equal(hasUpdatableFields(r), true);
    ok("ficha parcial envia só o que tem, com trim");
  }
  {
    const r = buildHitsGuestPutFromFnrh({ idEntity: 1, idReservation: 2, fnrh: {} });
    assert.equal(hasUpdatableFields(r), false);
    assert.deepEqual(Object.keys(r.dto), ["idEntity", "idReservation"]);
    ok("ficha vazia não gera PUT — o chamador não envia nada");
  }
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { data_nascimento: "1985-04-17T00:00:00.000Z", cidade: "Campo Grande" },
    });
    assert.equal(r.dto.birthdate, "1985-04-17");
    assert.deepEqual(r.dto.addresses, [{ city: "Campo Grande" }]);
    ok("data ISO vira YYYY-MM-DD; endereço parcial leva só o que existe");
  }
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { data_nascimento: "17/04/1985" },
    });
    assert.equal(r.dto.birthdate, undefined);
    ok("data em formato inesperado é omitida, não convertida no chute");
  }

  console.log("\n== Nada fora do cadastro do hóspede ==");
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: FICHA_COMPLETA,
      enums: { docType: { cpf: 2 }, contactTypePhone: 1, contactTypeEmail: 2, gender: { masculino: 0 } },
    });
    const chaves = Object.keys(r.dto);
    for (const proibido of ["status", "checkIn", "checkOut", "room", "rooms", "idRoom", "payment", "balance"]) {
      assert.equal(chaves.includes(proibido), false, `${proibido} não pode existir no DTO`);
    }
    ok("DTO não contém status, quarto, datas de estadia nem pagamento");
  }

  console.log(`\nOK test-fnrh-to-hits-guest (${cases} casos)`);
}

main();
