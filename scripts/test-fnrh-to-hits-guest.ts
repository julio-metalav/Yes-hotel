/**
 * Testes: FNRH → DTO de PAX do gateway. Função pura, sem rede.
 *
 * O foco é o que NÃO é enviado: enum não confirmado e campo sem correspondência
 * ficam de fora, porque gravar errado no cadastro do hóspede é pior do que não
 * gravar.
 */
import assert from "node:assert/strict";
import {
  buildHitsGuestPostFromFnrh,
  buildHitsGuestPutFromFnrh,
  findIdEntityByDoc,
  FNRH_TO_HITS_ENUMS_CONFIRMED,
  hasUpdatableFields,
  HITS_DOC_TYPE_CONHECIDOS,
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

  console.log("\n== Documento principal (exigido pelo HITS) ==");
  {
    // O HITS recusa o PUT sem documento principal:
    // 400 "Deve haver ao menos um documento principal informado".
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: FICHA_COMPLETA,
    });
    assert.equal(r.dto.doc, "12345678909");
    assert.equal(r.dto.docType, 2);
    ok("CPF vai por padrão como doc + docType=2");

    // Só CPF e passaporte: são os que o HITS aceita como documento principal.
    const enviados: Array<[string, number]> = [
      ["cpf", 2],
      ["passport", 1],
    ];
    for (const [tipo, esperado] of enviados) {
      const out = buildHitsGuestPutFromFnrh({
        idEntity: 1,
        idReservation: 2,
        fnrh: { ...FICHA_COMPLETA, documento_tipo: tipo },
      });
      assert.equal(out.dto.docType, esperado, `${tipo} → ${esperado}`);
      assert.equal(out.dto.doc, "12345678909", `${tipo} envia o número junto`);
    }
    ok("cpf→2 e passport→1 são os únicos enviados por padrão");

    // RG e certidão têm enum conhecido, mas não está confirmado que servem como
    // documento principal neste PUT. CNH e other não têm enum algum.
    for (const tipo of ["rg", "birth_certificate", "cnh", "other"]) {
      const out = buildHitsGuestPutFromFnrh({
        idEntity: 1,
        idReservation: 2,
        fnrh: { ...FICHA_COMPLETA, documento_tipo: tipo },
      });
      assert.equal(out.dto.docType, undefined, `${tipo} não entra por padrão`);
      assert.equal(out.dto.doc, undefined, `${tipo} não envia número sem tipo`);
      const motivos = new Map(out.omitted.map((o) => [o.field, o.reason]));
      assert.equal(motivos.get("doc"), "enum_nao_confirmado");
    }
    ok("rg, birth_certificate, cnh e other ficam fora deste fluxo");

    // O enum conhecido continua registrado, mesmo sem ser enviado.
    assert.equal(HITS_DOC_TYPE_CONHECIDOS.rg, 3);
    assert.equal(HITS_DOC_TYPE_CONHECIDOS.birth_certificate, 7);
    assert.equal(FNRH_TO_HITS_ENUMS_CONFIRMED.docType?.rg, undefined);
    assert.equal(FNRH_TO_HITS_ENUMS_CONFIRMED.docType?.birth_certificate, undefined);
    ok("RG e certidão seguem documentados como enum, fora do mapa de envio");
  }
  {
    // A FNRH valida por dígitos mas grava o texto digitado.
    const mascarado = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, documento_numero: "123.456.789-09" },
    });
    assert.equal(mascarado.dto.doc, "12345678909");
    ok("máscara de CPF é removida antes de enviar");

    const passaporte = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, documento_tipo: "passport", documento_numero: "AB123456" },
    });
    assert.equal(passaporte.dto.doc, "AB123456");
    ok("passaporte alfanumérico é preservado como está");
  }
  {
    const semDoc = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, documento_numero: "", documento_tipo: "" },
    });
    assert.equal(semDoc.dto.doc, undefined);
    assert.equal(semDoc.dto.docType, undefined);
    const motivos = new Map(semDoc.omitted.map((o) => [o.field, o.reason]));
    assert.equal(motivos.get("doc"), "vazio");
    ok("ficha sem documento não inventa par — quem recusa é o HITS");
  }

  console.log("\n== Contatos (confirmado por round-trip no Sandbox) ==");
  {
    // Ambos presentes: telefone no slot 1, e-mail no slot 2.
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: FICHA_COMPLETA,
    });
    assert.equal(r.dto.contact1, "67999990000");
    assert.equal(r.dto.contactType1, 2, "telefone → contactType 2");
    assert.equal(r.dto.contact2, "hospede.teste@example.com");
    assert.equal(r.dto.contactType2, 1, "e-mail → contactType 1");
    ok("telefone vai com contactType=2 e e-mail com contactType=1 por padrão");
  }
  {
    // Só e-mail: ocupa o slot 1 (formato provado); nada de contact2 inventado.
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, telefone: "" },
    });
    assert.equal(r.dto.contact1, "hospede.teste@example.com");
    assert.equal(r.dto.contactType1, 1);
    assert.equal(r.dto.contact2, undefined);
    assert.equal(r.dto.contactType2, undefined);
    ok("só e-mail: vai em contact1 com tipo 1, sem segundo contato");
  }
  {
    // Só telefone: idem.
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, email: "" },
    });
    assert.equal(r.dto.contact1, "67999990000");
    assert.equal(r.dto.contactType1, 2);
    assert.equal(r.dto.contact2, undefined);
    ok("só telefone: vai em contact1 com tipo 2, sem segundo contato");
  }
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: { ...FICHA_COMPLETA, email: "", telefone: "" },
    });
    assert.equal(r.dto.contact1, undefined);
    assert.equal(r.dto.contact2, undefined);
    const motivos = new Map(r.omitted.map((o) => [o.field, o.reason]));
    assert.equal(motivos.get("contato_telefone"), "vazio");
    assert.equal(motivos.get("contato_email"), "vazio");
    ok("sem contatos: nenhum slot é enviado");
  }
  {
    // Sem enum confirmado, o contato fica de fora — protege contra regressão
    // se alguém zerar o mapa.
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: FICHA_COMPLETA,
      enums: { docType: { cpf: 2 } },
    });
    assert.equal(r.dto.contact1, undefined);
    const motivos = new Map(r.omitted.map((o) => [o.field, o.reason]));
    assert.equal(motivos.get("contato_email"), "enum_nao_confirmado");
    ok("sem de/para de contato, nada é enviado nem inventado");
  }

  console.log("\n== PAX novo: item do POST derivado do mesmo mapeamento ==");
  {
    const item = buildHitsGuestPostFromFnrh(FICHA_COMPLETA);
    assert.deepEqual(item, {
      name: "Hospede Teste HITS",
      doc: "12345678909",
      docType: 2,
      contact: "67999990000",
      contactType: 2,
    });
    ok("POST leva só name, doc/docType e contact/contactType — nada além do contrato");

    const soEmail = buildHitsGuestPostFromFnrh({ ...FICHA_COMPLETA, telefone: "" });
    assert.equal(soEmail?.contact, "hospede.teste@example.com");
    assert.equal(soEmail?.contactType, 1);
    ok("sem telefone, o contato do POST é o e-mail com tipo 1");

    const semContato = buildHitsGuestPostFromFnrh({ ...FICHA_COMPLETA, telefone: "", email: "" });
    assert.equal(semContato?.contact, undefined);
    assert.equal(semContato?.contactType, undefined);
    ok("sem contato, o par não vai — o POST não exige");

    assert.equal(buildHitsGuestPostFromFnrh({ ...FICHA_COMPLETA, documento_numero: "" }), null);
    assert.equal(buildHitsGuestPostFromFnrh({ ...FICHA_COMPLETA, documento_tipo: "rg" }), null);
    assert.equal(buildHitsGuestPostFromFnrh({ ...FICHA_COMPLETA, hospede_nome: "" }), null);
    ok("sem documento principal ou sem nome não há POST — e não há como localizar o PAX depois");
  }

  console.log("\n== PAX novo: localizar idEntity no detalhe da reserva ==");
  {
    const detail = {
      idReservation: 17816,
      guests: [
        { idEntity: 141600, name: "AAAA", docCpfCnpjPassport: "11111111111" },
        { idEntity: 141601, name: "BBBB", docCpfCnpjPassport: "123.456.789-09" },
        { idEntity: 141602, name: "CCCC", docCpfCnpjPassport: null, federalRegistrationNumber: "22222222222" },
      ],
    };
    assert.equal(findIdEntityByDoc(detail, "12345678909"), "141601");
    assert.equal(findIdEntityByDoc(detail, "123.456.789-09"), "141601");
    ok("acha pelo documento comparando sem máscara nos dois lados");

    assert.equal(findIdEntityByDoc(detail, "22222222222"), "141602");
    ok("federalRegistrationNumber também conta como documento");

    assert.equal(findIdEntityByDoc(detail, "99999999999"), null);
    assert.equal(findIdEntityByDoc({ guests: [] }, "12345678909"), null);
    assert.equal(findIdEntityByDoc(null, "12345678909"), null);
    assert.equal(findIdEntityByDoc(detail, ""), null);
    ok("sem match, sem guests, sem detalhe ou sem doc → null, nunca um id inventado");

    const passaporte = { guests: [{ idEntity: 7, docCpfCnpjPassport: "AB123456" }] };
    assert.equal(findIdEntityByDoc(passaporte, "AB123456"), "7");
    assert.equal(findIdEntityByDoc(passaporte, "AB-123456"), null);
    ok("passaporte alfanumérico compara literal, sem limpar");

    assert.equal(findIdEntityByDoc({ guests: [{ idEntity: 0, docCpfCnpjPassport: "11111111111" }] }, "11111111111"), null);
    assert.equal(findIdEntityByDoc({ guests: [{ idEntity: "x", docCpfCnpjPassport: "11111111111" }] }, "11111111111"), null);
    ok("idEntity inválido no detalhe não é aceito");
  }

  console.log("\n== Omissão por enum não confirmado ==");
  {
    const r = buildHitsGuestPutFromFnrh({
      idEntity: 1,
      idReservation: 2,
      fnrh: FICHA_COMPLETA,
    });
    for (const campo of ["gender", "purposeTrip", "arrivingBy"]) {
      assert.equal((r.dto as Record<string, unknown>)[campo], undefined, `${campo} não pode ir sem de/para`);
    }
    ok("sexo, motivo e transporte seguem fora — só documento e contato confirmados");

    const motivos = new Map(r.omitted.map((o) => [o.field, o.reason]));
    assert.equal(motivos.get("gender"), "enum_nao_confirmado");
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
