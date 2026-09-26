/**
 * FNRH check-in digital v2 — jornada mobile-first (8 etapas).
 * Sem GOV.BR, OTP ou assinatura em canvas.
 * Depende de window.YES_HOTEL_SUPABASE_CONFIG e de guest_id/token na URL.
 */
(function (global) {
  "use strict";

  var DEBOUNCE_MS = 850;
  var STEPS = [
    { id: "documento", label: "Documento" },
    { id: "confira_dados", label: "Seus dados" },
    { id: "endereco", label: "Endereço" },
    { id: "viagem", label: "Viagem" },
    { id: "hospedes_menores", label: "Hóspedes" },
    { id: "revisao", label: "Revisão" },
    { id: "aceite", label: "Aceite" },
    { id: "concluido", label: "Concluído" },
  ];

  /**
   * Etapas que exibem campos lidos do documento. Só elas podem mostrar o aviso
   * "Encontramos estes dados no seu documento".
   *
   * Viagem, Revisão, Aceite e Concluído não têm o que conferir do documento --
   * o aviso aparecia nelas porque o shell usava a condição invertida.
   */
  var ETAPAS_COM_DADOS_DO_OCR = ["confira_dados"];

  var DOC_TYPES_BRASIL = [
    { value: "cpf", label: "Brasileiro — CPF" },
    { value: "passport", label: "Passaporte" },
  ];

  /**
   * Fluxo exterior. Nao assumir passaporte: vale tambem identidade estrangeira
   * e documento de viagem do Mercosul.
   *
   * LIMITACAO CONHECIDA: o banco aceita apenas
   * cpf|rg|cnh|passport|birth_certificate|other em `documento_tipo`. Nao ha
   * valor proprio para "identidade estrangeira" nem para "Mercosul", e esta
   * correcao nao cria schema novo. Os dois caem em `other`, qualificados por
   * `pais_emissor`, e ficam indistinguiveis entre si no banco. Separar exige
   * migration -- decisao deliberadamente adiada.
   */
  var DOC_TYPES_EXTERIOR = [
    { value: "passport", label: "Passaporte" },
    {
      value: "other",
      label: "Identidade estrangeira ou documento de viagem (Mercosul)",
    },
  ];

  function docTypesFor(state) {
    return isBrazilResident(state) ? DOC_TYPES_BRASIL : DOC_TYPES_EXTERIOR;
  }

  var MOTIVO_OPTIONS = [
    { value: "lazer", label: "Lazer / turismo" },
    { value: "negocios", label: "Negócios" },
    { value: "evento", label: "Evento" },
    { value: "saude", label: "Saúde" },
    { value: "estudo", label: "Estudo" },
    { value: "outro", label: "Outro" },
  ];

  var TRANSPORTE_OPTIONS = [
    { value: "carro", label: "Carro" },
    { value: "aviao", label: "Avião" },
    { value: "onibus", label: "Ônibus" },
    { value: "outro", label: "Outro" },
  ];

  var RELATION_OPTIONS = [
    { value: "pai", label: "Pai" },
    { value: "mae", label: "Mãe" },
    { value: "tutor_responsavel_legal", label: "Tutor / responsável legal" },
    { value: "outro", label: "Outro" },
  ];

  var ACCOMPANIMENT_OPTIONS = [
    { value: "acompanhado_por_pai_mae", label: "Acompanho como pai/mãe" },
    { value: "acompanhado_por_responsavel_legal", label: "Acompanho como responsável legal" },
    { value: "acompanhado_por_terceiro_autorizado", label: "Terceiro autorizado" },
  ];

  function escapeHtml(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : String(s);
    return div.innerHTML;
  }

  function formatTime(d) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  function digitsOnly(v) {
    return String(v || "").replace(/\D/g, "");
  }

  function hasText(v) {
    return v != null && String(v).trim() !== "";
  }

  function isBrazilResident(state) {
    // "Resido no exterior" é um estado global da jornada (Etapa 1 ou os
    // atalhos junto ao CPF e ao CEP). Quando o hóspede decidiu, a decisão
    // vale -- sem isso, um brasileiro que mora fora voltava ao fluxo Brasil
    // enquanto o endereço estrangeiro ainda estava vazio. Sem decisão
    // explícita (recarga sem preferência salva), segue a heurística abaixo,
    // que é a mesma do servidor.
    if (state.residenciaExterior === true) return false;
    if (state.residenciaExterior === false) return true;
    var pais = String(state.pais || "Brasil").trim().toLowerCase();
    if (!pais || pais === "brasil" || pais === "brazil" || pais === "br") return true;
    var nac = String(state.nacionalidade || "").trim().toLowerCase();
    if (nac.indexOf("brasil") >= 0 || nac === "brasileira" || nac === "brasileiro") {
      return !hasText(state.endereco_estrangeiro);
    }
    return false;
  }

  function needsTwoSides(docType) {
    // Jornada canônica: CPF / passaporte (documento físico CNH/RG é só fonte).
    // Mantido por compatibilidade; não é o caminho normal document-first.
    return docType === "rg" || docType === "cnh";
  }

  function isCanonicalDocType(docType) {
    return docType === "cpf" || docType === "passport";
  }

  function normalizeDocumentoTipo(raw) {
    var t = String(raw || "").trim().toLowerCase();
    if (isCanonicalDocType(t)) return t;
    return "";
  }

  function documentoNumeroLabel(docType) {
    if (docType === "passport") return "Número do passaporte *";
    if (docType === "cpf") return "CPF *";
    return "Número do documento *";
  }

  function labelOf(options, value) {
    for (var i = 0; i < options.length; i++) {
      if (options[i].value === value) return options[i].label;
    }
    return value || "—";
  }

  function optionHtml(options, selected) {
    return options
      .map(function (o) {
        return (
          '<option value="' +
          escapeHtml(o.value) +
          '"' +
          (o.value === selected ? " selected" : "") +
          ">" +
          escapeHtml(o.label) +
          "</option>"
        );
      })
      .join("");
  }

  /* ------------------------------------------------------------------ *
   * Idioma do modo exterior.
   *
   * Português é o padrão (fluxo Brasil). Ao ativar "Resido no exterior" o
   * hóspede escolhe Español ou English e a jornada inteira segue nesse
   * idioma. A tradução é aplicada sobre o HTML já renderizado (nós de texto
   * e alguns atributos), a partir do texto em português. Assim o markup de
   * cada etapa continua um só -- não existe layout paralelo por idioma -- e
   * os textos em português seguem literais no código.
   * ------------------------------------------------------------------ */
  var I18N_PARES = [
    // [português, español, english]
    ["Documento", "Documento", "Document"],
    ["Seus dados", "Sus datos", "Your details"],
    ["Endereço", "Dirección", "Address"],
    ["Viagem", "Viaje", "Trip"],
    ["Hóspedes", "Huéspedes", "Guests"],
    ["Revisão", "Revisión", "Review"],
    ["Aceite", "Aceptación", "Consent"],
    ["Concluído", "Finalizado", "Done"],
    ["Última etapa", "Último paso", "Last step"],
    ["Voltar", "Volver", "Back"],
    ["Progresso do check-in", "Progreso del check-in", "Check-in progress"],
    ["Idioma e residência", "Idioma y residencia", "Language and residence"],
    ["Campo obrigatório.", "Campo obligatorio.", "Required field."],
    ["Preencha seus dados na próxima etapa.", "Complete sus datos en el siguiente paso.", "Fill in your details on the next step."],
    [
      "Confira e complete seus dados na próxima etapa.",
      "Revise y complete sus datos en el siguiente paso.",
      "Check and complete your details on the next step.",
    ],
    [
      "Não há menores vinculados a você nesta reserva. Toque em Continuar.",
      "No hay menores vinculados a usted en esta reserva. Toque Continuar.",
      "There are no minors linked to you in this booking. Tap Continue.",
    ],
    [
      "Se houver crianças no grupo, elas devem estar cadastradas com você como responsável.",
      "Si hay niños en el grupo, deben estar registrados con usted como responsable.",
      "If there are children in your group, they must be registered with you as the responsible adult.",
    ],
    ["Continuar", "Continuar", "Continue"],
    ["Selecione…", "Seleccione…", "Select…"],
    ["· opcional", "· opcional", "· optional"],
    ["Do documento", "Del documento", "From your document"],
    ["Corrigido por você", "Corregido por usted", "Edited by you"],
    // Etapa 1
    ["Seu documento", "Su documento", "Your ID"],
    [
      "Passaporte, identidade estrangeira ou documento Mercosul. Tire uma foto ou envie um arquivo. Nós preenchemos os dados para você.",
      "Pasaporte, documento de identidad extranjero o documento Mercosur. Tome una foto o envíe un archivo. Completamos los datos por usted.",
      "Passport, national ID card or Mercosur travel document. Take a photo or upload a file. We fill in your details for you.",
    ],
    ["Tirar foto do documento", "Tomar foto del documento", "Take a photo of your ID"],
    ["Usar a câmera do celular", "Usar la cámara del celular", "Use your phone camera"],
    ["Enviar imagem ou PDF", "Enviar imagen o PDF", "Upload an image or PDF"],
    [
      "Escolher um arquivo já salvo no aparelho",
      "Elegir un archivo guardado en el teléfono",
      "Choose a file saved on your phone",
    ],
    [
      "Dica: documento inteiro, com boa luz e sem reflexo.",
      "Consejo: documento completo, con buena luz y sin reflejos.",
      "Tip: whole document, good light, no glare.",
    ],
    ["Resido no exterior", "Resido en el exterior", "I live abroad"],
    ["Alterar idioma", "Cambiar idioma", "Change language"],
    [
      "Usado apenas para sua ficha de hospedagem",
      "Usado solo para su ficha de registro",
      "Used only for your guest registration",
    ],
    ["Tirar foto do verso", "Tomar foto del reverso", "Take a photo of the back"],
    ["Enviar verso do documento", "Enviar reverso del documento", "Upload the back of your ID"],
    ["Escolha uma imagem ou PDF já salvo", "Elija una imagen o PDF guardado", "Choose a saved image or PDF"],
    [
      "Este documento precisa do verso. Envie a segunda foto.",
      "Este documento necesita el reverso. Envíe la segunda foto.",
      "This document needs the back side. Please send a second photo.",
    ],
    ["Enviando…", "Enviando…", "Uploading…"],
    ["Enviando documento…", "Enviando documento…", "Uploading document…"],
    ["Aguarde um instante.", "Espere un momento.", "One moment, please."],
    ["Lendo documento…", "Leyendo documento…", "Reading document…"],
    [
      "Estamos identificando seus dados automaticamente. Isso pode levar alguns segundos.",
      "Estamos identificando sus datos automáticamente. Puede tardar unos segundos.",
      "We're reading your details automatically. This may take a few seconds.",
    ],
    ["Documento recebido · lendo dados…", "Documento recibido · leyendo datos…", "Document received · reading details…"],
    ["Documento recebido", "Documento recibido", "Document received"],
    [
      "Leitura concluída. Confira os dados e complete o que faltar.",
      "Lectura concluida. Revise los datos y complete lo que falte.",
      "Reading complete. Check your details and fill in anything missing.",
    ],
    ["Leitura concluída ✓", "Lectura concluida ✓", "Reading complete ✓"],
    ["Documento enviado ✓", "Documento enviado ✓", "Document uploaded ✓"],
    [
      "Nome, documento e data de nascimento identificados.",
      "Nombre, documento y fecha de nacimiento identificados.",
      "Name, ID number and date of birth found.",
    ],
    ["Alguns dados não foram identificados.", "Algunos datos no fueron identificados.", "Some details could not be found."],
    [
      "Não identificamos dados neste arquivo. Você poderá preencher na próxima etapa.",
      "No identificamos datos en este archivo. Podrá completarlos en el siguiente paso.",
      "We couldn't find details in this file. You can fill them in on the next step.",
    ],
    ["Imagem", "Imagen", "Image"],
    ["Pré-visualização do documento", "Vista previa del documento", "Document preview"],
    ["Trocar documento", "Cambiar documento", "Replace document"],
    ["Conferir meus dados", "Revisar mis datos", "Check my details"],
    // Etapa 2
    [
      "Confira o que lemos do documento e complete o que faltar.",
      "Revise lo que leímos del documento y complete lo que falte.",
      "Check what we read from your document and fill in anything missing.",
    ],
    ["Sobre você", "Sobre usted", "About you"],
    ["Contato", "Contacto", "Contact"],
    ["Nome completo", "Nombre completo", "Full name"],
    ["Nome social", "Nombre social", "Preferred name"],
    ["Como prefere ser chamado(a)", "Cómo prefiere que lo llamemos", "What should we call you?"],
    ["Data de nascimento", "Fecha de nacimiento", "Date of birth"],
    ["Nacionalidade", "Nacionalidad", "Nationality"],
    ["ex.: Argentina", "ej.: Argentina", "e.g. Canadian"],
    ["Tipo de documento", "Tipo de documento", "Document type"],
    ["Passaporte", "Pasaporte", "Passport"],
    [
      "Identidade estrangeira ou documento de viagem (Mercosul)",
      "Documento de identidad extranjero o de viaje (Mercosur)",
      "National ID card or Mercosur travel document",
    ],
    ["Número do passaporte", "Número de pasaporte", "Passport number"],
    ["Número do documento", "Número de documento", "Document number"],
    ["País emissor do documento", "País emisor del documento", "Issuing country"],
    ["Não é preciso CPF.", "No se necesita CPF.", "A Brazilian CPF is not required."],
    ["Escolha o país", "Elija el país", "Choose a country"],
    ["Celular com código do país", "Celular con código de país", "Mobile with country code"],
    ["E-mail", "Correo electrónico", "Email"],
    [
      "Enviaremos por aqui as instruções de acesso.",
      "Enviaremos aquí las instrucciones de acceso.",
      "We'll send your access instructions here.",
    ],
    ["Confirmar dados", "Confirmar datos", "Confirm details"],
    // Etapa 3 (exterior)
    ["Onde você mora?", "¿Dónde vive?", "Where do you live?"],
    ["Seu endereço residencial.", "Su dirección de residencia.", "Your home address."],
    ["País", "País", "Country"],
    ["Rua e número", "Calle y número", "Street address"],
    ["Complemento", "Departamento, piso", "Apartment, suite"],
    ["Apto, andar, unidade", "Depto., piso, unidad", "Apt, floor, unit"],
    ["Cidade", "Ciudad", "City"],
    ["Estado / província", "Estado / provincia", "State / province"],
    ["Código postal", "Código postal", "Postal code"],
    ["Mora no Brasil?", "¿Vive en Brasil?", "Live in Brazil?"],
    ["Voltar ao fluxo Brasil", "Volver al formulario de Brasil", "Switch to the Brazil form"],
    ["Escolha o país onde você mora.", "Elija el país donde vive.", "Choose the country where you live."],
    [
      "Para endereço no Brasil, use o fluxo Brasil.",
      "Para una dirección en Brasil, use el formulario de Brasil.",
      "For an address in Brazil, use the Brazil form.",
    ],
    ["Informe a rua e o número.", "Indique calle y número.", "Enter your street address."],
    ["Informe a cidade.", "Indique la ciudad.", "Enter your city."],
    ["Informe o endereço completo no exterior.", "Indique su dirección completa.", "Enter your full address."],
    // Etapa 4
    ["Sobre sua viagem", "Sobre su viaje", "About your trip"],
    [
      "Só precisamos de algumas informações para completar sua ficha.",
      "Solo necesitamos algunos datos para completar su ficha.",
      "We just need a few details to complete your registration.",
    ],
    ["Motivo da viagem", "Motivo del viaje", "Purpose of your trip"],
    ["Meio de transporte", "Medio de transporte", "How you're travelling"],
    ["Lazer / turismo", "Ocio / turismo", "Leisure / tourism"],
    ["Negócios", "Negocios", "Business"],
    ["Evento", "Evento", "Event"],
    ["Saúde", "Salud", "Health"],
    ["Estudo", "Estudios", "Study"],
    ["Outro", "Otro", "Other"],
    ["Carro", "Auto", "Car"],
    ["Avião", "Avión", "Plane"],
    ["Ônibus", "Autobús", "Bus"],
    ["Procedência", "Procedencia", "Coming from"],
    ["De onde você vem.", "De dónde viene.", "City or country you're coming from."],
    ["Destino", "Destino", "Next destination"],
    ["Cidade para onde segue", "Ciudad a la que sigue", "Where you're going next"],
    ["Placa do veículo", "Patente del vehículo", "Licence plate"],
    ["Cor do veículo", "Color del vehículo", "Vehicle colour"],
    ["Modelo do veículo", "Modelo del vehículo", "Vehicle model"],
    // Menores
    ["Menores sob sua responsabilidade", "Menores a su cargo", "Minors in your care"],
    [
      "Confirme o parentesco e o acompanhamento de cada menor sob sua responsabilidade.",
      "Confirme el parentesco y el acompañamiento de cada menor a su cargo.",
      "Confirm the relationship and supervision of each minor in your care.",
    ],
    ["Parentesco", "Parentesco", "Relationship"],
    ["Descreva o parentesco", "Describa el parentesco", "Describe the relationship"],
    ["Acompanhamento", "Acompañamiento", "Supervision"],
    ["Pai", "Padre", "Father"],
    ["Mãe", "Madre", "Mother"],
    ["Tutor / responsável legal", "Tutor / responsable legal", "Guardian / legal representative"],
    ["Acompanho como pai/mãe", "Acompaño como padre/madre", "I'm the parent"],
    ["Acompanho como responsável legal", "Acompaño como responsable legal", "I'm the legal guardian"],
    ["Terceiro autorizado", "Tercero autorizado", "Authorised third party"],
    ["Menor", "Menor", "Minor"],
    // Revisão
    ["Confira seus dados", "Revise sus datos", "Check your details"],
    [
      "Revise as informações abaixo antes de continuar.",
      "Revise la información antes de continuar.",
      "Review the information below before continuing.",
    ],
    ["Dados pessoais", "Datos personales", "Personal details"],
    ["Menores", "Menores", "Minors"],
    ["Alterar", "Cambiar", "Edit"],
    ["Nascimento", "Nacimiento", "Date of birth"],
    ["Tipo", "Tipo", "Type"],
    ["Número", "Número", "Number"],
    ["País emissor", "País emisor", "Issuing country"],
    ["Celular", "Celular", "Mobile"],
    ["Motivo", "Motivo", "Purpose"],
    ["Transporte", "Transporte", "Transport"],
    ["Placa", "Patente", "Licence plate"],
    ["corrigido", "corregido", "edited"],
    ["Documento estrangeiro", "Documento extranjero", "Foreign ID"],
    ["Corrigir informações", "Corregir información", "Edit information"],
    // Aceite
    ["Confirme e aceite", "Confirme y acepte", "Confirm and accept"],
    [
      "Leia os documentos abaixo e confirme para concluir seu check-in.",
      "Lea los documentos y confirme para completar su check-in.",
      "Read the documents below and confirm to complete your check-in.",
    ],
    [
      "Confirmo que os dados informados nesta ficha estão corretos e completos.",
      "Confirmo que los datos de esta ficha son correctos y completos.",
      "I confirm that the information in this form is correct and complete.",
    ],
    ["Li e aceito os", "He leído y acepto los", "I have read and accept the"],
    ["Termos de Hospedagem", "Términos de Hospedaje", "Terms of Stay"],
    ["e o", "y el", "and the"],
    ["Aviso de Privacidade", "Aviso de Privacidad", "Privacy Notice"],
    ["Marque este item para enviar.", "Marque este ítem para enviar.", "Tick this box to submit."],
    ["Confirmar e enviar", "Confirmar y enviar", "Confirm and submit"],
    ["Confirmando…", "Confirmando…", "Confirming…"],
    // Concluído
    ["Cadastro concluído com sucesso", "Registro completado con éxito", "Registration completed"],
    [
      "Os dados da sua FNRH foram atualizados com sucesso.",
      "Los datos de su ficha de registro se guardaron correctamente.",
      "Your guest registration details have been saved.",
    ],
    [
      "As credenciais de acesso e demais orientações serão enviadas em breve.",
      "Las credenciales de acceso y demás instrucciones se enviarán en breve.",
      "Your access credentials and other instructions will be sent shortly.",
    ],
    ["Seja bem-vindo(a) ao Yes Hotel.", "Bienvenido(a) a Yes Hotel.", "Welcome to Yes Hotel."],
    // Mensagens de validação e de envio
    [
      "Envie uma foto ou arquivo do documento para continuar.",
      "Envíe una foto o un archivo del documento para continuar.",
      "Upload a photo or file of your ID to continue.",
    ],
    [
      "Este documento precisa da foto do verso. Envie o verso para continuar.",
      "Este documento necesita la foto del reverso. Envíela para continuar.",
      "This document needs a photo of the back. Upload it to continue.",
    ],
    ["Nome completo é obrigatório.", "Indique su nombre completo.", "Enter your full name."],
    ["Selecione o tipo de documento.", "Seleccione el tipo de documento.", "Select the document type."],
    [
      "Para quem reside fora do Brasil, escolha passaporte ou documento estrangeiro.",
      "Si vive fuera de Brasil, elija pasaporte o documento extranjero.",
      "If you live outside Brazil, choose passport or foreign ID.",
    ],
    ["Informe o número do documento.", "Indique el número del documento.", "Enter the document number."],
    ["Data de nascimento é obrigatória.", "Indique su fecha de nacimiento.", "Enter your date of birth."],
    ["Nacionalidade é obrigatória.", "Indique su nacionalidad.", "Enter your nationality."],
    ["Telefone é obrigatório.", "Indique su teléfono.", "Enter your phone number."],
    ["E-mail é obrigatório.", "Indique su correo electrónico.", "Enter your email."],
    [
      "Este documento exige frente e verso. Volte à etapa Documento e envie o verso.",
      "Este documento requiere frente y reverso. Vuelva al paso Documento y envíe el reverso.",
      "This document needs both sides. Go back to the Document step and upload the back.",
    ],
    ["Selecione o motivo da viagem.", "Seleccione el motivo del viaje.", "Select the purpose of your trip."],
    ["Selecione o meio de transporte.", "Seleccione el medio de transporte.", "Select how you're travelling."],
    ["Informe a procedência.", "Indique de dónde viene.", "Enter where you're coming from."],
    ["Informe o destino.", "Indique su próximo destino.", "Enter your next destination."],
    ["Informe a placa do veículo.", "Indique la patente del vehículo.", "Enter the licence plate."],
    ["Informe o parentesco de cada menor.", "Indique el parentesco de cada menor.", "Enter the relationship for each minor."],
    ["Descreva o parentesco (outro) do menor.", "Describa el parentesco del menor.", "Describe the minor's relationship."],
    ["Informe como o menor está acompanhado.", "Indique cómo está acompañado el menor.", "Enter how the minor is supervised."],
    ["Marque as duas declarações para concluir.", "Marque las dos declaraciones para completar.", "Tick both boxes to finish."],
    [
      "Não conseguimos falar com o servidor. Verifique sua conexão e tente de novo.",
      "No pudimos conectar con el servidor. Revise su conexión e inténtelo de nuevo.",
      "We couldn't reach the server. Check your connection and try again.",
    ],
    [
      "O servidor não conseguiu processar o documento. Tente novamente em instantes.",
      "El servidor no pudo procesar el documento. Inténtelo de nuevo en unos instantes.",
      "The server couldn't process the document. Please try again shortly.",
    ],
    [
      "Resposta inesperada do servidor ao enviar o documento. Tente novamente.",
      "Respuesta inesperada del servidor al enviar el documento. Inténtelo de nuevo.",
      "Unexpected server response while uploading. Please try again.",
    ],
    ["Falha no envio do documento.", "No se pudo enviar el documento.", "The document upload failed."],
    ["Erro de conexão. Tente novamente.", "Error de conexión. Inténtelo de nuevo.", "Connection error. Please try again."],
    ["Falha ao confirmar.", "No se pudo confirmar.", "Couldn't confirm."],
    ["Não foi possível salvar o rascunho.", "No se pudo guardar el progreso.", "Couldn't save your progress."],
    ["Erro de rede ao salvar rascunho.", "Error de red al guardar el progreso.", "Network error while saving your progress."],
  ];

  var I18N_REGRAS = [
    [/^ETAPA (\d+) DE (\d+)$/, "PASO $1 DE $2", "STEP $1 OF $2"],
    [/^Apto (.+)$/, "Hab. $1", "Room $1"],
    [/^Progresso salvo às (.+)\.$/, "Progreso guardado a las $1.", "Progress saved at $1."],
    [/^Termos (\S+) · Privacidade (\S+)$/, "Términos $1 · Privacidad $2", "Terms $1 · Privacy $2"],
    [
      /^Arquivo grande demais \(limite de (\d+) MB\)\. Envie uma foto ou reduza o PDF\.$/,
      "Archivo demasiado grande (límite de $1 MB). Envíe una foto o reduzca el PDF.",
      "File too large ($1 MB limit). Upload a photo or a smaller PDF.",
    ],
  ];

  var I18N_MAPA = { es: {}, en: {} };
  I18N_PARES.forEach(function (p) {
    I18N_MAPA.es[p[0]] = p[1];
    I18N_MAPA.en[p[0]] = p[2];
  });

  function traduzirTexto(texto, lang) {
    if (lang !== "es" && lang !== "en") return texto;
    var s = String(texto);
    var core = s.trim();
    if (!core) return s;
    var lead = s.slice(0, s.indexOf(core));
    var tail = s.slice(s.indexOf(core) + core.length);
    var mapa = I18N_MAPA[lang];
    if (Object.prototype.hasOwnProperty.call(mapa, core)) return lead + mapa[core] + tail;
    var seguir = /^A seguir: (.+)$/.exec(core);
    if (seguir) {
      return lead + (lang === "es" ? "Siguiente: " : "Next: ") + traduzirTexto(seguir[1], lang) + tail;
    }
    for (var i = 0; i < I18N_REGRAS.length; i++) {
      var r = I18N_REGRAS[i];
      if (r[0].test(core)) return lead + core.replace(r[0], lang === "es" ? r[1] : r[2]) + tail;
    }
    return s;
  }

  function traduzirArvore(root, lang) {
    if (!root || (lang !== "es" && lang !== "en")) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nos = [];
    while (walker.nextNode()) nos.push(walker.currentNode);
    nos.forEach(function (n) {
      var t = traduzirTexto(n.nodeValue, lang);
      if (t !== n.nodeValue) n.nodeValue = t;
    });
    root.querySelectorAll("[placeholder],[aria-label],[alt],[title]").forEach(function (el) {
      ["placeholder", "aria-label", "alt", "title"].forEach(function (attr) {
        if (!el.hasAttribute(attr)) return;
        var v = el.getAttribute(attr);
        var t = traduzirTexto(v, lang);
        if (t !== v) el.setAttribute(attr, t);
      });
    });
  }

  /**
   * Países para o endereço e o país emissor no modo exterior. O nome é
   * exibido no idioma do hóspede, mas gravado sempre em português -- o
   * mesmo formato de texto livre que `pais` e `pais_emissor` já recebiam.
   */
  var CODIGOS_PAISES = (
    "AD AE AF AG AI AL AM AO AR AS AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ " +
    "CA CD CF CG CH CI CK CL CM CN CO CR CU CV CW CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FK FM " +
    "FO FR GA GB GD GE GF GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM " +
    "JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM " +
    "MN MO MQ MR MS MT MU MV MW MX MY MZ NA NC NE NG NI NL NO NP NR NZ OM PA PE PF PG PH PK PL PR PS PT " +
    "PW PY QA RE RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TL " +
    "TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WS XK YE ZA ZM ZW"
  ).split(" ");

  function nomesDePaises(lang) {
    if (typeof Intl === "undefined" || typeof Intl.DisplayNames !== "function") return null;
    try {
      var exibir = new Intl.DisplayNames([lang === "es" ? "es" : lang === "en" ? "en" : "pt-BR"], {
        type: "region",
      });
      var gravar = new Intl.DisplayNames(["pt-BR"], { type: "region" });
      return CODIGOS_PAISES.map(function (c) {
        return { code: c, label: exibir.of(c) || c, value: gravar.of(c) || c };
      }).sort(function (a, b) {
        return a.label.localeCompare(b.label);
      });
    } catch (_e) {
      return null;
    }
  }

  function ehBrasil(v) {
    var s = String(v || "").trim().toLowerCase();
    return s === "brasil" || s === "brazil" || s === "br";
  }

  /**
   * @param {{
   *   appEl: HTMLElement,
   *   guestId: string,
   *   token: string,
   *   functionsUrl: string,
   *   data: object
   * }} opts
   */
  function start(opts) {
    var app = opts.appEl;
    var guestId = opts.guestId;
    var token = opts.token;
    var functionsUrl = opts.functionsUrl;
    var data = opts.data || {};

    if (typeof document !== "undefined" && document.body) {
      document.body.classList.add("yh-v2-page");
    }

    if (data.is_minor) {
      app.innerHTML =
        '<div class="yh-v2"><header class="yh-header yh-header--center">' +
        '<img class="yh-logo" src="./assets/yes-hotel-logo-horizontal-claro.svg" alt="Yes Hotel" width="66" height="32" />' +
        '</header><main class="yh-main">' +
        "<h1>Check-in digital</h1>" +
        '<p class="banner">A ficha de menores é preenchida e confirmada pelo <strong>responsável</strong> pelo link dele. ' +
        "Use o link enviado ao adulto responsável desta reserva.</p>" +
        "</main></div>";
      return;
    }

    var pre = data.preenchido || {};
    var minors = Array.isArray(data.minors)
      ? data.minors
      : Array.isArray(data.menores)
        ? data.menores
        : [];
    var documents = Array.isArray(data.documents) ? data.documents : [];
    var termsVersion = data.terms_version || "terms-v1-2026-08";
    var privacyVersion = data.privacy_notice_version || "privacy-v1-2026-08";
    var meta = data.meta || {};
    var flags = data.feature_flags || {};

    // Preferências só de interface (modo exterior, idioma, partes do endereço
    // estrangeiro). Ficam na sessão do navegador para sobreviver a um reload;
    // nada disso vai ao servidor além dos campos que já existiam.
    var PREFS_KEY = "yh_fnrh_ui_v1_" + String(guestId || "");
    function lerPrefs() {
      try {
        var raw = sessionStorage.getItem(PREFS_KEY);
        return raw ? JSON.parse(raw) || {} : {};
      } catch (_e) {
        return {};
      }
    }
    var prefs = lerPrefs();

    var state = {
      stepIndex: 0,
      documento_tipo: normalizeDocumentoTipo(pre.documento_tipo),
      documento_numero: pre.documento_numero || pre.documento || "",
      pais_emissor: pre.pais_emissor || "",
      documento: pre.documento || pre.documento_numero || "",
      data_nascimento: pre.data_nascimento ? String(pre.data_nascimento).slice(0, 10) : "",
      hospede_nome: pre.hospede_nome || "",
      nome_social: pre.nome_social || "",
      nacionalidade: pre.nacionalidade || "",
      telefone: pre.telefone || "",
      email: pre.email || "",
      cep: pre.cep || "",
      logradouro: pre.logradouro || "",
      numero: pre.numero || "",
      complemento: pre.complemento || "",
      bairro: pre.bairro || "",
      cidade: pre.cidade || "",
      uf: pre.uf || "",
      pais: pre.pais || "Brasil",
      endereco_estrangeiro: pre.endereco_estrangeiro || "",
      endereco: pre.endereco || "",
      procedencia: pre.procedencia || "",
      destino: pre.destino || "",
      motivo_viagem: pre.motivo_viagem || "",
      meio_transporte: pre.meio_transporte || "",
      placa_veiculo: pre.placa_veiculo || "",
      cor_veiculo: pre.cor_veiculo || "",
      modelo_veiculo: pre.modelo_veiculo || "",
      // Aceite nunca inicia marcado na UI
      data_confirmed: false,
      privacy_accepted: false,
      has_document_upload: documents.some(function (d) {
        return d && d.storage_ref_present;
      }),
      uploadedSides: {},
      minors: minors.map(function (m) {
        return {
          guest_id: m.guest_id || m.id || "",
          nome: m.nome || "",
          data_nascimento: m.data_nascimento ? String(m.data_nascimento).slice(0, 10) : "",
          minor_relation: m.minor_relation || "",
          minor_relation_other: m.minor_relation_other || "",
          minor_accompaniment: m.minor_accompaniment || "",
          nacionalidade: m.nacionalidade || "",
          documento_tipo: normalizeDocumentoTipo(m.documento_tipo),
          documento_numero: m.documento_numero || "",
          status: m.status || "",
        };
      }),
      analyzing: false,
      analyzingPhase: "",
      cepLoading: false,
      cepError: "",
      stepError: "",
      ocrBanner: "",
      fieldOrigin: Object.assign({}, data.field_provenance || {}),
      dirtyManualFields: {},
      reviewFields: {},
      docPreviewUrl: "",
      docPreviewName: "",
      showConfiraCta: false,
      draftStatus: "",
      draftOk: null,
      confirmBusy: false,
      // Estado global "Resido no exterior" (undefined = sem decisão explícita).
      residenciaExterior:
        prefs.exterior === true ? true : prefs.exterior === false ? false : undefined,
      lang: prefs.lang === "es" || prefs.lang === "en" ? prefs.lang : "pt",
      langSheet: "",
      extPartes: Object.assign(
        { rua: "", complemento: "", cidade: "", regiao: "", postal: "" },
        prefs.partes || {},
      ),
      ocrKeys: {},
      ocrResultado: "",
      cepFound: false,
      scrollToError: false,
    };

    // Campos que já vieram do documento em outra sessão continuam marcados.
    Object.keys(state.fieldOrigin || {}).forEach(function (k) {
      if (state.fieldOrigin[k] === "ocr") state.ocrKeys[k] = true;
    });
    if (!isBrazilResident(state) && state.lang === "pt") {
      // Modo exterior sem idioma escolhido (ex.: nova sessão): pergunta de novo.
      state.langSheet = "gerenciar";
    }
    // Endereço estrangeiro gravado antes, sem as partes na sessão: o texto
    // inteiro vai para a primeira linha, para não se perder.
    if (
      hasText(state.endereco_estrangeiro) &&
      !hasText(state.extPartes.rua) &&
      !hasText(state.extPartes.cidade)
    ) {
      state.extPartes.rua = state.endereco_estrangeiro;
    }

    function salvarPrefs() {
      try {
        sessionStorage.setItem(
          PREFS_KEY,
          JSON.stringify({
            exterior: state.residenciaExterior,
            lang: state.lang,
            partes: state.extPartes,
          }),
        );
      } catch (_e) {
        /* navegador sem sessionStorage: segue sem persistir */
      }
    }

    /**
     * Único ponto que liga/desliga o modo exterior (Etapa 1 e os atalhos
     * junto ao CPF e ao CEP chegam aqui). Mesma regra que o seletor da
     * Etapa 2 aplicava antes: CPF não é opção no exterior.
     */
    function aplicarResidencia(exterior, lang) {
      if (exterior) {
        state.residenciaExterior = true;
        if (ehBrasil(state.pais) || !hasText(state.pais)) state.pais = "Exterior";
        state.cep = "";
        state.cepFound = false;
        if (state.documento_tipo === "cpf") {
          state.documento_tipo = "";
          state.documento_numero = "";
          state.documento = "";
        }
        state.lang = lang === "es" ? "es" : "en";
      } else {
        state.residenciaExterior = false;
        state.pais = "Brasil";
        state.endereco_estrangeiro = "";
        state.pais_emissor = "";
        state.lang = "pt";
      }
      markDirtyManual("pais");
      salvarPrefs();
      scheduleDraft();
    }

    // Marca lados já enviados (heurística: qualquer doc do tipo)
    if (state.has_document_upload) {
      state.uploadedSides.single = true;
    }

    var draftTimer = null;
    var draftAbort = null;

    function submitUrl() {
      return functionsUrl + "/fnrh-submit";
    }
    function uploadUrl() {
      return functionsUrl + "/fnrh-document-upload";
    }

    function collectDraftBody() {
      var body = {
        hospede_id: guestId,
        guest_id: guestId,
        token: token,
        action: "draft",
        flow_version: "v2",
        hospede_nome: state.hospede_nome,
        nome_social: state.nome_social,
        documento_tipo: state.documento_tipo,
        documento_numero: state.documento_numero,
        documento: state.documento_numero || state.documento,
        data_nascimento: state.data_nascimento || null,
        nacionalidade: state.nacionalidade,
        cep: state.cep,
        logradouro: state.logradouro,
        numero: state.numero,
        complemento: state.complemento,
        bairro: state.bairro,
        cidade: state.cidade,
        uf: state.uf,
        pais: state.pais,
        pais_emissor: state.pais_emissor,
        endereco_estrangeiro: state.endereco_estrangeiro,
        telefone: state.telefone,
        email: state.email,
        procedencia: state.procedencia,
        destino: state.destino,
        motivo_viagem: state.motivo_viagem,
        meio_transporte: state.meio_transporte,
        placa_veiculo: state.placa_veiculo,
        cor_veiculo: state.cor_veiculo,
        modelo_veiculo: state.modelo_veiculo,
        terms_version: termsVersion,
        privacy_notice_version: privacyVersion,
        // Não persistir aceite como true via autosave até o usuário marcar na etapa
        data_confirmed: false,
        privacy_accepted: false,
        dirty_manual_fields: Object.keys(state.dirtyManualFields || {}),
      };
      return body;
    }

    function doDraft() {
      if (draftAbort) draftAbort.abort();
      draftAbort = new AbortController();
      fetch(submitUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectDraftBody()),
        signal: draftAbort.signal,
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (res) {
          if (res.ok) {
            state.draftStatus = "Progresso salvo às " + formatTime(new Date()) + ".";
            state.draftOk = true;
          } else {
            state.draftStatus = res.error || "Não foi possível salvar o rascunho.";
            state.draftOk = false;
          }
          updateDraftStatusEl();
        })
        .catch(function (e) {
          if (e && e.name === "AbortError") return;
          state.draftStatus = "Erro de rede ao salvar rascunho.";
          state.draftOk = false;
          updateDraftStatusEl();
        });
    }

    function scheduleDraft() {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(doDraft, DEBOUNCE_MS);
    }

    function updateDraftStatusEl() {
      var el = document.getElementById("v2-draft-status");
      if (!el) return;
      el.textContent = traduzirTexto(state.draftStatus || "", state.lang);
      el.className =
        "draft-status" +
        (state.draftOk === true ? " is-ok" : state.draftOk === false ? " is-err" : " muted");
    }

    function markDirtyManual(key) {
      if (!key) return;
      state.dirtyManualFields = state.dirtyManualFields || {};
      state.dirtyManualFields[key] = true;
      state.fieldOrigin = state.fieldOrigin || {};
      state.fieldOrigin[key] = "manual";
    }

    function syncStateFromDom() {
      var root = document.getElementById("v2-step-body");
      if (!root) return;
      root.querySelectorAll("[data-field]").forEach(function (el) {
        var key = el.getAttribute("data-field");
        if (!key) return;
        var nextVal = el.type === "checkbox" ? !!el.checked : el.value;
        var prevVal = state[key];
        if (el.type === "checkbox") {
          state[key] = nextVal;
        } else {
          if (key === "documento_tipo") {
            nextVal = normalizeDocumentoTipo(nextVal);
          }
          state[key] = nextVal;
        }
        if (String(prevVal == null ? "" : prevVal) !== String(nextVal == null ? "" : nextVal)) {
          markDirtyManual(key);
        }
      });
      root.querySelectorAll("[data-minor-field]").forEach(function (el) {
        var idx = parseInt(el.getAttribute("data-minor-index"), 10);
        var key = el.getAttribute("data-minor-field");
        if (isNaN(idx) || !state.minors[idx] || !key) return;
        state.minors[idx][key] = el.value;
      });
      // Endereço no exterior: a interface pede rua, complemento, cidade,
      // estado/província e código postal; o contrato de dados continua o
      // mesmo -- tudo vai composto em `endereco_estrangeiro`, com o país.
      var extEls = root.querySelectorAll("[data-ext]");
      if (extEls.length) {
        extEls.forEach(function (el) {
          state.extPartes[el.getAttribute("data-ext")] = el.value;
        });
        var partes = state.extPartes;
        var composto = [
          partes.rua,
          partes.complemento,
          partes.cidade,
          partes.regiao,
          partes.postal,
          hasText(state.pais) && state.pais !== "Exterior" ? state.pais : "",
        ]
          .map(function (v) {
            return String(v || "").trim();
          })
          .filter(Boolean)
          .join(", ");
        if (composto !== String(state.endereco_estrangeiro || "")) {
          state.endereco_estrangeiro = composto;
          markDirtyManual("endereco_estrangeiro");
        }
        salvarPrefs();
      }
    }

    function hasLinkedMinors() {
      return Array.isArray(state.minors) && state.minors.length > 0;
    }

    /** Etapas exibidas na jornada (pula Hóspedes se não houver menores). */
    function isStepVisible(stepId) {
      if (stepId === "hospedes_menores" && !hasLinkedMinors()) return false;
      return true;
    }

    function visibleSteps() {
      return STEPS.filter(function (s) {
        return isStepVisible(s.id);
      });
    }

    function visibleStepMeta() {
      var vis = visibleSteps();
      var currentId = STEPS[state.stepIndex] ? STEPS[state.stepIndex].id : "";
      var visualIndex = 0;
      for (var i = 0; i < vis.length; i++) {
        if (vis[i].id === currentId) {
          visualIndex = i;
          break;
        }
      }
      return { steps: vis, visualIndex: visualIndex, total: vis.length };
    }

    /** Avança/volta no índice lógico STEPS, pulando etapas invisíveis. */
    function nextVisibleStepIndex(fromIndex, direction) {
      var i = fromIndex + direction;
      while (i >= 0 && i < STEPS.length) {
        if (isStepVisible(STEPS[i].id)) return i;
        i += direction;
      }
      return fromIndex;
    }

    /** Evita stepIndex em etapa pulada (reload / navegação). */
    function ensureVisibleStepIndex() {
      if (!STEPS[state.stepIndex]) {
        state.stepIndex = 0;
        return;
      }
      if (isStepVisible(STEPS[state.stepIndex].id)) return;
      var forward = nextVisibleStepIndex(state.stepIndex, 1);
      if (forward !== state.stepIndex && isStepVisible(STEPS[forward].id)) {
        state.stepIndex = forward;
        return;
      }
      var backward = nextVisibleStepIndex(state.stepIndex, -1);
      if (backward !== state.stepIndex && isStepVisible(STEPS[backward].id)) {
        state.stepIndex = backward;
        return;
      }
      state.stepIndex = 0;
    }

    function documentUploadComplete() {
      if (!state.has_document_upload) return false;
      if (needsTwoSides(state.documento_tipo)) {
        return !!(state.uploadedSides.front && state.uploadedSides.back);
      }
      return !!(state.uploadedSides.single || state.uploadedSides.front || state.has_document_upload);
    }

    function needsVersoAfterOcr() {
      return needsTwoSides(state.documento_tipo) && !!state.uploadedSides.front && !state.uploadedSides.back;
    }

    function validateCurrentStep() {
      var id = STEPS[state.stepIndex].id;
      state.stepError = "";

      if (id === "documento") {
        if (!state.has_document_upload) {
          state.stepError = "Envie uma foto ou arquivo do documento para continuar.";
          return false;
        }
        if (needsVersoAfterOcr()) {
          state.stepError = "Este documento precisa da foto do verso. Envie o verso para continuar.";
          return false;
        }
        return true;
      }

      if (id === "confira_dados") {
        if (!hasText(state.hospede_nome)) {
          state.stepError = "Nome completo é obrigatório.";
          return false;
        }
        if (!hasText(state.documento_tipo)) {
          state.stepError = "Selecione o tipo de documento.";
          return false;
        }
        // CPF é obrigatório no fluxo brasileiro e impossível no fluxo exterior:
        // quem mora fora não é obrigado a ter CPF para se hospedar.
        if (!isBrazilResident(state) && state.documento_tipo === "cpf") {
          state.stepError =
            "Para quem reside fora do Brasil, escolha passaporte ou documento estrangeiro.";
          return false;
        }
        if (!hasText(state.documento_numero)) {
          state.stepError = "Informe o número do documento.";
          return false;
        }
        if (!hasText(state.data_nascimento)) {
          state.stepError = "Data de nascimento é obrigatória.";
          return false;
        }
        if (!hasText(state.nacionalidade)) {
          state.stepError = "Nacionalidade é obrigatória.";
          return false;
        }
        if (!hasText(state.telefone)) {
          state.stepError = "Telefone é obrigatório.";
          return false;
        }
        if (!hasText(state.email)) {
          state.stepError = "E-mail é obrigatório.";
          return false;
        }
        if (needsTwoSides(state.documento_tipo) && !(state.uploadedSides.front && state.uploadedSides.back)) {
          state.stepError =
            "Este documento exige frente e verso. Volte à etapa Documento e envie o verso.";
          return false;
        }
        return true;
      }

      if (id === "endereco") {
        if (isBrazilResident(state)) {
          if (digitsOnly(state.cep).length !== 8) {
            state.stepError = "Informe um CEP válido com 8 dígitos.";
            return false;
          }
          if (
            !hasText(state.logradouro) ||
            !hasText(state.numero) ||
            !hasText(state.bairro) ||
            !hasText(state.cidade) ||
            String(state.uf || "").trim().length !== 2
          ) {
            state.stepError = "Complete logradouro, número, bairro, cidade e UF.";
            return false;
          }
        } else {
          // Modo exterior: o endereço residencial não pode ser no Brasil.
          if (!hasText(state.pais) || state.pais === "Exterior") {
            state.stepError = "Escolha o país onde você mora.";
            return false;
          }
          if (ehBrasil(state.pais)) {
            state.stepError = "Para endereço no Brasil, use o fluxo Brasil.";
            return false;
          }
          if (!hasText(state.extPartes.rua)) {
            state.stepError = "Informe a rua e o número.";
            return false;
          }
          if (!hasText(state.extPartes.cidade)) {
            state.stepError = "Informe a cidade.";
            return false;
          }
          if (!hasText(state.endereco_estrangeiro)) {
            state.stepError = "Informe o endereço completo no exterior.";
            return false;
          }
        }
        return true;
      }

      if (id === "viagem") {
        if (!hasText(state.motivo_viagem)) {
          state.stepError = "Selecione o motivo da viagem.";
          return false;
        }
        if (!hasText(state.meio_transporte)) {
          state.stepError = "Selecione o meio de transporte.";
          return false;
        }
        if (!hasText(state.procedencia)) {
          state.stepError = "Informe a procedência.";
          return false;
        }
        if (!hasText(state.destino)) {
          state.stepError = "Informe o destino.";
          return false;
        }
        var meio = String(state.meio_transporte).toLowerCase();
        if ((meio === "carro" || meio === "automovel" || meio === "veiculo") && !hasText(state.placa_veiculo)) {
          state.stepError = "Informe a placa do veículo.";
          return false;
        }
        return true;
      }

      if (id === "hospedes_menores") {
        for (var i = 0; i < state.minors.length; i++) {
          var m = state.minors[i];
          if (!hasText(m.minor_relation)) {
            state.stepError = "Informe o parentesco de cada menor.";
            return false;
          }
          if (m.minor_relation === "outro" && !hasText(m.minor_relation_other)) {
            state.stepError = "Descreva o parentesco (outro) do menor.";
            return false;
          }
          if (!hasText(m.minor_accompaniment)) {
            state.stepError = "Informe como o menor está acompanhado.";
            return false;
          }
        }
        return true;
      }

      if (id === "aceite") {
        if (!state.data_confirmed || !state.privacy_accepted) {
          state.stepError = "Marque as duas declarações para concluir.";
          return false;
        }
        return true;
      }

      return true;
    }

    function goNext() {
      syncStateFromDom();
      if (!validateCurrentStep()) {
        state.scrollToError = true;
        render();
        return;
      }
      var stepId = STEPS[state.stepIndex].id;
      if (stepId === "aceite") {
        confirmAndFinish();
        return;
      }
      if (stepId === "concluido") return;
      scheduleDraft();
      state.stepIndex = nextVisibleStepIndex(state.stepIndex, 1);
      state.stepError = "";
      render();
    }

    function goBack() {
      syncStateFromDom();
      if (state.stepIndex > 0 && STEPS[state.stepIndex].id !== "concluido") {
        state.stepIndex = nextVisibleStepIndex(state.stepIndex, -1);
        state.stepError = "";
        render();
      }
    }

    function applyOcrSuggestions(fields, meta) {
      if (!fields || typeof fields !== "object") return;
      meta = meta || {};
      var review = Array.isArray(meta.needs_review_fields) ? meta.needs_review_fields : [];
      var map = {
        hospede_nome: "hospede_nome",
        nome: "hospede_nome",
        data_nascimento: "data_nascimento",
        documento_numero: "documento_numero",
        documento: "documento_numero",
        documento_tipo: "documento_tipo",
        nacionalidade: "nacionalidade",
        sexo: "sexo",
        cpf: "documento_numero",
      };
      var applied = 0;
      var lidos = {};
      Object.keys(map).forEach(function (k) {
        var target = map[k];
        if (!hasText(fields[k])) return;
        state.fieldOrigin = state.fieldOrigin || {};
        // manual > ocr: só bloqueia se o hóspede já preencheu valor canônico
        if (state.fieldOrigin[target] === "manual" && hasText(state[target])) {
          if (!(target === "documento_tipo" && !isCanonicalDocType(state[target]))) {
            return;
          }
        }
        var val = String(fields[k]).trim();
        if (target === "documento_tipo") {
          val = normalizeDocumentoTipo(val);
          if (!val) return;
        }
        if (k === "cpf") {
          // CPF canônico: tipo + número
          if (state.fieldOrigin.documento_tipo !== "manual") {
            state.documento_tipo = "cpf";
            state.fieldOrigin.documento_tipo = "ocr";
          }
          val = val.replace(/\D/g, "");
        }
        if (target === "data_nascimento") val = val.slice(0, 10);
        state[target] = val;
        if (target === "documento_numero") state.documento = val;
        state.fieldOrigin[target] = "ocr";
        state.ocrKeys[target] = true;
        lidos[target] = true;
        if (review.indexOf(k) >= 0 || review.indexOf(target) >= 0) {
          state.reviewFields = state.reviewFields || {};
          state.reviewFields[target] = true;
        }
        applied += 1;
      });
      if (applied > 0) {
        state.ocrBanner =
          "Encontramos estes dados no seu documento. Confira e corrija se necessário.";
      } else {
        state.ocrBanner =
          "Alguns dados não foram identificados. Confira e complete os campos abaixo.";
      }
      // Resultado da leitura para a Etapa 1 (completo / parcial / nenhum):
      // o OCR pode trazer tudo, parte ou nada, conforme a qualidade do arquivo.
      var principais = ["hospede_nome", "documento_numero", "data_nascimento"];
      var achados = principais.filter(function (k) {
        return !!lidos[k];
      }).length;
      state.ocrResultado =
        achados === principais.length ? "completo" : applied > 0 ? "parcial" : "nenhum";
    }

    function setDocPreview(file) {
      if (state.docPreviewUrl) {
        try {
          URL.revokeObjectURL(state.docPreviewUrl);
        } catch (_e) {
          /* ignore */
        }
      }
      state.docPreviewUrl = "";
      state.docPreviewName = file && file.name ? String(file.name) : "";
      if (file && file.type && String(file.type).indexOf("image/") === 0) {
        try {
          state.docPreviewUrl = URL.createObjectURL(file);
        } catch (_e2) {
          state.docPreviewUrl = "";
        }
      }
    }

    var TAMANHO_MAXIMO_MB = 10;

    /**
     * Mensagem que reflete a causa, nao o sintoma.
     *
     * Antes, qualquer falha virava "Erro de conexão ao enviar o documento" --
     * inclusive arquivo grande demais e resposta não-JSON da plataforma. O
     * hóspede tentava de novo na mesma conexão e falhava de novo.
     */
    function mensagemDeFalhaNoEnvio(res, file) {
      if (res.body && res.body.error) return String(res.body.error);

      var tamanhoMb = file && file.size ? file.size / (1024 * 1024) : 0;
      if (res.status === 413 || tamanhoMb > TAMANHO_MAXIMO_MB) {
        return (
          "Arquivo grande demais (limite de " +
          TAMANHO_MAXIMO_MB +
          " MB). Envie uma foto ou reduza o PDF."
        );
      }
      if (res.status >= 500) {
        return "O servidor não conseguiu processar o documento. Tente novamente em instantes.";
      }
      if (!res.body) {
        return "Resposta inesperada do servidor ao enviar o documento. Tente novamente.";
      }
      return "Falha no envio do documento.";
    }

    function uploadDocument(file, side) {
      if (!file) return;
      var uploadSide = side || "front";
      setDocPreview(file);
      state.analyzing = true;
      state.analyzingPhase = "upload";
      state.stepError = "";
      state.ocrBanner = "";
      state.showConfiraCta = false;
      render();

      var fd = new FormData();
      fd.append("guest_id", guestId);
      fd.append("token", token);
      fd.append("document_type", state.documento_tipo || "other");
      fd.append("document_subject", "guest");
      fd.append("side", uploadSide);
      fd.append("file", file, file.name || "documento");

      // Transição visual: após iniciar o POST, mostrar fase OCR (re-render para botão + preview)
      window.setTimeout(function () {
        if (state.analyzing && state.analyzingPhase === "upload") {
          state.analyzingPhase = "ocr";
          render();
        }
      }, 450);

      fetch(uploadUrl(), { method: "POST", body: fd })
        .then(function (r) {
          // A resposta nem sempre e JSON: limite de tamanho, proxy e erro de
          // plataforma devolvem texto ou HTML. Tratar isso como "erro de
          // conexao" escondia a causa real -- foi o que aconteceu com PDF.
          return r
            .json()
            .then(function (j) {
              return { okHttp: r.ok, status: r.status, body: j };
            })
            .catch(function () {
              return { okHttp: r.ok, status: r.status, body: null };
            });
        })
        .then(function (res) {
          state.analyzing = false;
          state.analyzingPhase = "";
          if (!res.body || !res.body.ok) {
            state.stepError = mensagemDeFalhaNoEnvio(res, file);
            // O que ja foi digitado nao se perde por causa de um envio falho.
            scheduleDraft();
            render();
            return;
          }
          state.has_document_upload = true;
          state.uploadedSides[uploadSide] = true;
          if (uploadSide === "single") state.uploadedSides.front = true;
          applyOcrSuggestions(res.body.suggested_fields, {
            needs_review_fields: res.body.needs_review_fields,
            ocr_skipped: res.body.ocr_skipped,
            ocr_reason: res.body.ocr_reason,
            ok: res.body.ok,
          });
          if (!needsVersoAfterOcr()) {
            state.showConfiraCta = true;
          }
          scheduleDraft();
          render();
        })
        .catch(function () {
          state.analyzing = false;
          state.analyzingPhase = "";
          // Aqui sim e falha de rede: o fetch nem completou.
          state.stepError =
            "Não conseguimos falar com o servidor. Verifique sua conexão e tente de novo.";
          scheduleDraft();
          render();
        });
    }

    function lookupCep() {
      var cep = digitsOnly(state.cep);
      if (cep.length !== 8) {
        state.cepError = "CEP deve ter 8 dígitos.";
        render();
        return;
      }
      state.cepLoading = true;
      state.cepError = "";
      state.cepFound = false;
      render();
      fetch("https://viacep.com.br/ws/" + cep + "/json/")
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          state.cepLoading = false;
          if (j.erro) {
            state.cepError = "CEP não encontrado.";
            render();
            return;
          }
          state.logradouro = j.logradouro || state.logradouro;
          state.bairro = j.bairro || state.bairro;
          state.cidade = j.localidade || state.cidade;
          state.uf = j.uf || state.uf;
          state.pais = "Brasil";
          state.endereco_estrangeiro = "";
          state.cepFound = true;
          markDirtyManual("cep");
          markDirtyManual("logradouro");
          markDirtyManual("bairro");
          markDirtyManual("cidade");
          markDirtyManual("uf");
          markDirtyManual("pais");
          scheduleDraft();
          render();
        })
        .catch(function () {
          state.cepLoading = false;
          state.cepError = "Não foi possível consultar o CEP.";
          render();
        });
    }

    function confirmAndFinish() {
      syncStateFromDom();
      if (!validateCurrentStep()) {
        render();
        return;
      }
      state.confirmBusy = true;
      state.stepError = "";
      render();

      var body = {
        hospede_id: guestId,
        guest_id: guestId,
        token: token,
        action: "confirm",
        flow_version: "v2",
        confirm_own: true,
        hospede_nome: state.hospede_nome,
        nome_social: state.nome_social,
        documento_tipo: state.documento_tipo,
        documento_numero: state.documento_numero,
        documento: state.documento_numero || state.documento,
        data_nascimento: state.data_nascimento || null,
        nacionalidade: state.nacionalidade,
        cep: state.cep,
        logradouro: state.logradouro,
        numero: state.numero,
        complemento: state.complemento,
        bairro: state.bairro,
        cidade: state.cidade,
        uf: state.uf,
        pais: state.pais,
        pais_emissor: state.pais_emissor,
        endereco_estrangeiro: state.endereco_estrangeiro,
        telefone: state.telefone,
        email: state.email,
        procedencia: state.procedencia,
        destino: state.destino,
        motivo_viagem: state.motivo_viagem,
        meio_transporte: state.meio_transporte,
        placa_veiculo: state.placa_veiculo,
        cor_veiculo: state.cor_veiculo,
        modelo_veiculo: state.modelo_veiculo,
        data_confirmed: true,
        privacy_accepted: true,
        terms_version: termsVersion,
        privacy_notice_version: privacyVersion,
        confirm_minors: state.minors.map(function (m) {
          return {
            guest_id: m.guest_id,
            hospede_nome: m.nome,
            data_nascimento: m.data_nascimento || null,
            nacionalidade: m.nacionalidade || state.nacionalidade,
            documento_tipo: m.documento_tipo || "",
            documento_numero: m.documento_numero || "",
            minor_relation: m.minor_relation,
            minor_relation_other: m.minor_relation_other,
            minor_accompaniment: m.minor_accompaniment,
            data_confirmed: true,
            privacy_accepted: true,
            terms_version: termsVersion,
            privacy_notice_version: privacyVersion,
          };
        }),
      };

      fetch(submitUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (res) {
          state.confirmBusy = false;
          if (res.ok) {
            state.stepIndex = STEPS.length - 1;
            state.stepError = "";
            render();
          } else {
            var detail = "";
            if (res.details && Array.isArray(res.details.missing) && res.details.missing.length) {
              detail = " Faltando: " + res.details.missing.join(", ") + ".";
            }
            state.stepError = (res.error || "Falha ao confirmar.") + detail;
            render();
          }
        })
        .catch(function () {
          state.confirmBusy = false;
          state.stepError = "Erro de conexão. Tente novamente.";
          render();
        });
    }

    function progressPct() {
      // concluído = 100%; demais etapas proporcionais às etapas VISÍVEIS
      ensureVisibleStepIndex();
      var meta = visibleStepMeta();
      if (STEPS[state.stepIndex].id === "concluido") return 100;
      var denom = Math.max(1, meta.total - 1);
      return Math.round(((meta.visualIndex + 1) / denom) * 100);
    }

    /* ---------------------------------------------------------------- *
     * Componentes visuais (design final aprovado: base clara, petróleo
     * como ação, dourado como acento, campos leves, um CTA por etapa).
     * ---------------------------------------------------------------- */
    var SVG_OPEN =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
    var ICON = {
      camera:
        SVG_OPEN +
        ' stroke-width="1.8"><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13.5" r="3.5"/></svg>',
      upload:
        SVG_OPEN +
        ' stroke-width="1.8"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z"/><path d="M14 3v5h5M12 18v-6M9.5 14.5 12 12l2.5 2.5"/></svg>',
      file:
        SVG_OPEN +
        ' stroke-width="1.6"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
      chevron: SVG_OPEN + ' stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>',
      arrow: SVG_OPEN + ' stroke-width="2.2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
      check: SVG_OPEN + ' stroke-width="2.6"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
      alert:
        SVG_OPEN + ' stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.01"/></svg>',
      lock:
        SVG_OPEN +
        ' stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
      globe:
        SVG_OPEN +
        ' stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3Z"/></svg>',
      docCard:
        SVG_OPEN +
        ' stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M14 10h4M14 14h4"/></svg>',
      pencil: SVG_OPEN + ' stroke-width="2"><path d="M4 20h4L18 10l-4-4L4 16v4Z"/><path d="M12.5 7.5l4 4"/></svg>',
    };

    /** Mensagem de validação → campo que a recebe (a regra continua em validateCurrentStep). */
    var ERRO_CAMPO = {
      "Nome completo é obrigatório.": "hospede_nome",
      "Selecione o tipo de documento.": "documento_tipo",
      "Para quem reside fora do Brasil, escolha passaporte ou documento estrangeiro.": "documento_tipo",
      "Informe o número do documento.": "documento_numero",
      "Data de nascimento é obrigatória.": "data_nascimento",
      "Nacionalidade é obrigatória.": "nacionalidade",
      "Telefone é obrigatório.": "telefone",
      "E-mail é obrigatório.": "email",
      "Informe um CEP válido com 8 dígitos.": "cep",
      "Escolha o país onde você mora.": "pais",
      "Para endereço no Brasil, use o fluxo Brasil.": "pais",
      "Informe a rua e o número.": "ext_rua",
      "Informe a cidade.": "ext_cidade",
      "Informe o endereço completo no exterior.": "ext_rua",
      "Selecione o motivo da viagem.": "motivo_viagem",
      "Selecione o meio de transporte.": "meio_transporte",
      "Informe a procedência.": "procedencia",
      "Informe o destino.": "destino",
      "Informe a placa do veículo.": "placa_veiculo",
      "Marque as duas declarações para concluir.": "aceite",
    };

    function campoDoErro() {
      var msg = state.stepError || "";
      if (!msg) return "";
      if (msg === "Complete logradouro, número, bairro, cidade e UF.") {
        var ordem = ["logradouro", "numero", "bairro", "cidade", "uf"];
        for (var i = 0; i < ordem.length; i++) {
          var k = ordem[i];
          var vazio = k === "uf" ? String(state.uf || "").trim().length !== 2 : !hasText(state[k]);
          if (vazio) return k;
        }
        return "logradouro";
      }
      return ERRO_CAMPO[msg] || "";
    }

    function erroDoCampo(key) {
      if (!state.stepError) return "";
      if (campoDoErro() !== key) return "";
      if (state.stepError === "Complete logradouro, número, bairro, cidade e UF.") {
        return "Campo obrigatório.";
      }
      return state.stepError;
    }

    function tagOrigem(key) {
      var origem = state.fieldOrigin ? state.fieldOrigin[key] : "";
      if (origem === "ocr" && hasText(state[key])) {
        return '<span class="yh-tag yh-tag--doc">' + ICON.docCard + "<span>Do documento</span></span>";
      }
      if (origem === "manual" && state.ocrKeys[key]) {
        return '<span class="yh-tag yh-tag--manual">' + ICON.pencil + "<span>Corrigido por você</span></span>";
      }
      return "";
    }

    function inputTag(id, err, aria, attrs, value) {
      return (
        '<input class="yh-input' +
        (err ? " is-invalid" : "") +
        '" id="' +
        id +
        '" ' +
        attrs +
        aria +
        ' value="' +
        escapeHtml(value) +
        '" />'
      );
    }

    function selectTag(id, err, aria, attrs, optionsHtml) {
      return (
        '<select class="yh-input yh-select' +
        (err ? " is-invalid" : "") +
        '" id="' +
        id +
        '" ' +
        attrs +
        aria +
        ">" +
        optionsHtml +
        "</select>"
      );
    }

    function opcoesPaises(atual, incluirBrasil, vazioValor) {
      var lista = nomesDePaises(state.lang);
      if (!lista) return null;
      var html = ['<option value="' + escapeHtml(vazioValor) + '">Escolha o país</option>'];
      var achou = false;
      lista.forEach(function (p) {
        if (!incluirBrasil && p.code === "BR") return;
        var sel = hasText(atual) && String(atual).trim().toLowerCase() === p.value.toLowerCase();
        if (sel) achou = true;
        html.push(
          '<option value="' + escapeHtml(p.value) + '"' + (sel ? " selected" : "") + ">" + escapeHtml(p.label) + "</option>",
        );
      });
      // Valor antigo em texto livre continua visível e selecionado.
      if (!achou && hasText(atual) && atual !== vazioValor && (incluirBrasil || !ehBrasil(atual))) {
        html.splice(1, 0, '<option value="' + escapeHtml(atual) + '" selected>' + escapeHtml(atual) + "</option>");
      }
      return html.join("");
    }

    /**
     * Um campo: rótulo, marcação de origem (documento / corrigido), controle,
     * ajuda e erro. Obrigatório é o padrão; só o opcional é sinalizado.
     */
    function campoHtml(o) {
      var id = "f-" + o.key;
      var err = erroDoCampo(o.errKey || o.key);
      var ids = [];
      if (o.hint) ids.push(id + "-hint");
      if (err) ids.push(id + "-err");
      var aria =
        (err ? ' aria-invalid="true"' : "") + (ids.length ? ' aria-describedby="' + ids.join(" ") + '"' : "");
      return [
        '<div class="yh-field' + (err ? " has-error" : "") + '">',
        '<div class="yh-field__head">',
        '<label class="yh-label" for="' +
          id +
          '">' +
          escapeHtml(o.label) +
          (o.optional ? ' <span class="yh-optional">· opcional</span>' : "") +
          "</label>",
        o.tag === false ? "" : tagOrigem(o.key),
        "</div>",
        o.control(id, err, aria),
        o.hint ? '<p class="yh-hint" id="' + id + '-hint">' + escapeHtml(o.hint) + "</p>" : "",
        err
          ? '<p class="yh-field-error" id="' +
            id +
            '-err" role="alert">' +
            ICON.alert +
            "<span>" +
            escapeHtml(err) +
            "</span></p>"
          : "",
        o.after || "",
        "</div>",
      ].join("");
    }

    function introHtml(titulo, lead) {
      return (
        '<div class="yh-intro"><h2 class="yh-title">' +
        escapeHtml(titulo) +
        "</h2>" +
        (lead ? '<p class="yh-lead">' + escapeHtml(lead) + "</p>" : "") +
        "</div>"
      );
    }

    function documentoRecebido() {
      return (
        !!(state.has_document_upload || state.uploadedSides.front || state.uploadedSides.single) &&
        !needsVersoAfterOcr()
      );
    }

    function formatarData(iso) {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
      return m ? m[3] + "/" + m[2] + "/" + m[1] : String(iso || "");
    }

    function formatarCep(v) {
      var d = digitsOnly(v);
      return d.length === 8 ? d.slice(0, 5) + "-" + d.slice(5) : String(v || "");
    }

    function sheetHtml() {
      if (!state.langSheet) return "";
      var exterior = !isBrazilResident(state);
      function opcao(lang, rotulo) {
        var atual = exterior && state.lang === lang;
        return (
          '<button type="button" class="yh-sheet__opt' +
          (atual ? " is-current" : "") +
          '" data-lang="' +
          lang +
          '" lang="' +
          lang +
          '"' +
          (atual ? ' aria-current="true"' : "") +
          ">" +
          "<span>" +
          rotulo +
          "</span>" +
          (atual ? ICON.check : ICON.chevron) +
          "</button>"
        );
      }
      return [
        '<div class="yh-sheet-backdrop" id="yh-sheet-backdrop"></div>',
        '<div class="yh-sheet" role="dialog" aria-modal="true" aria-labelledby="yh-sheet-title">',
        '<span class="yh-sheet__handle" aria-hidden="true"></span>',
        '<div class="yh-sheet__head">',
        '<h2 id="yh-sheet-title" lang="en">Choose your language</h2>',
        '<p lang="es">Elija su idioma</p>',
        "</div>",
        '<div class="yh-sheet__options">',
        opcao("es", "Español"),
        opcao("en", "English"),
        "</div>",
        exterior
          ? '<button type="button" class="yh-btn-text yh-btn-text--block" id="yh-sheet-brasil">Voltar ao fluxo Brasil</button>'
          : '<button type="button" class="yh-btn-text yh-btn-text--block" id="yh-sheet-cancel">Cancelar · continuar no Brasil</button>',
        "</div>",
      ].join("");
    }

    var ultimoPassoRenderizado = -1;

    function renderShell(bodyHtml, navOpts) {
      navOpts = navOpts || {};
      ensureVisibleStepIndex();
      var stepMeta = visibleStepMeta();
      var step = STEPS[state.stepIndex];
      var concluido = step.id === "concluido";
      var exterior = !isBrazilResident(state);
      // Feedback de processamento fica no card do documento (próximo ao preview no mobile).
      //
      // O aviso do OCR pertence a UMA etapa: "Confira dados", a única que
      // mostra os campos lidos do documento. Ela já renderiza o próprio banner
      // em renderConfiraDados.
      //
      // A condição daqui era `step.id !== "confira_dados"` -- invertida: o
      // shell imprimia o aviso em TODAS as outras etapas. Era por isso que
      // "Encontramos estes dados no seu documento" reaparecia em Viagem,
      // Revisão, Aceite e Concluído, onde não há nada do documento para
      // conferir. No redesign, nem a própria etapa 2 usa banner: cada campo
      // lido traz a marca discreta "Do documento".
      var ocrBanner = ocrBannerDaEtapa(step.id);
      // Erro ligado a um campo aparece junto do campo; o resto, no rodapé.
      var err =
        state.stepError && !campoDoErro()
          ? '<p class="error" id="v2-step-error" role="alert">' + escapeHtml(state.stepError) + "</p>"
          : "";

      var backBtn =
        navOpts.hideBack || state.stepIndex === 0 || step.id === "concluido"
          ? ""
          : '<button type="button" class="yh-btn-text" id="v2-back">Voltar</button>';
      var nextLabel = "Continuar";
      if (step.id === "aceite") {
        nextLabel = state.confirmBusy ? "Confirmando…" : "Confirmar e enviar";
      } else if (state.analyzing) {
        nextLabel =
          state.analyzingPhase === "ocr" ? "Lendo documento…" : "Enviando documento…";
      } else if (step.id === "confira_dados" || step.id === "revisao") {
        nextLabel = "Confirmar dados";
      } else if (step.id === "documento") {
        nextLabel = "Conferir meus dados";
      }
      // Na etapa do documento, depois da leitura, quem avança é "Conferir meus
      // dados". Manter também o "Continuar" do shell deixava duas ações
      // primárias competindo pela mesma decisão.
      var leituraConcluida = step.id === "documento" && docLeituraConcluida();
      // Antes do envio a etapa já oferece as duas formas de enviar; um botão
      // de avanço ali só levaria a um erro.
      var aguardandoDocumento = step.id === "documento" && !state.analyzing && !documentoRecebido();
      var ocupado = state.confirmBusy || state.analyzing;
      var nextBtn =
        step.id === "concluido" || leituraConcluida || aguardandoDocumento
          ? ""
          : '<button type="button" class="yh-btn-primary" id="v2-next"' +
            (state.confirmBusy || state.analyzing ? " disabled" : "") +
            ">" +
            (ocupado ? '<span class="doc-spinner doc-spinner--light" aria-hidden="true"></span>' : "") +
            "<span>" +
            escapeHtml(nextLabel) +
            "</span>" +
            (ocupado || step.id === "aceite" ? "" : ICON.arrow) +
            "</button>";

      var visualNum =
        step.id === "concluido" ? stepMeta.total : stepMeta.visualIndex + 1;

      var apto = meta.apartamento
        ? '<span class="yh-apto">Apto ' + escapeHtml(meta.apartamento) + "</span>"
        : "";
      var langBtn = exterior
        ? '<button type="button" class="yh-lang" id="yh-lang-btn" aria-label="Idioma e residência">' +
          ICON.globe +
          "<span>" +
          (state.lang === "es" ? "ES" : state.lang === "en" ? "EN" : "PT") +
          "</span></button>"
        : "";

      var progress = "";
      if (!concluido) {
        var barras = [];
        for (var i = 0; i < stepMeta.total; i++) {
          barras.push(
            '<span class="yh-progress__bar' +
              (i < stepMeta.visualIndex ? " is-done" : i === stepMeta.visualIndex ? " is-current" : "") +
              '"></span>',
          );
        }
        var proxima = stepMeta.steps[stepMeta.visualIndex + 1];
        var proximaTexto =
          proxima && proxima.id !== "concluido" ? "A seguir: " + proxima.label : "Última etapa";
        progress = [
          '<div class="yh-progress" role="progressbar" aria-label="Progresso do check-in" aria-valuemin="1" aria-valuemax="' +
            stepMeta.total +
            '" aria-valuenow="' +
            visualNum +
            '">',
          '<div class="yh-progress__bars">' + barras.join("") + "</div>",
          '<div class="yh-progress__meta">',
          '<span class="yh-eyebrow">' + escapeHtml("ETAPA " + visualNum + " DE " + stepMeta.total) + "</span>",
          '<span class="yh-next">' + escapeHtml(proximaTexto) + "</span>",
          "</div>",
          "</div>",
        ].join("");
      }

      var nota =
        navOpts.footerNote != null
          ? navOpts.footerNote
          : '<p class="draft-status" id="v2-draft-status" aria-live="polite"></p>';
      var navRow =
        backBtn || nextBtn || navOpts.primaryHtml
          ? '<div class="yh-nav">' + backBtn + nextBtn + (navOpts.primaryHtml || "") + "</div>"
          : "";
      var footer = concluido
        ? ""
        : '<footer class="yh-footer">' + err + nota + navRow + (navOpts.afterHtml || "") + "</footer>";

      app.innerHTML = [
        '<div class="yh-v2' + (concluido ? " yh-v2--done" : "") + '">',
        '<header class="yh-header' + (concluido ? " yh-header--center" : "") + '">',
        '<h1 class="yh-sr-only">Check-in digital</h1>',
        '<img class="yh-logo" src="./assets/yes-hotel-logo-horizontal-claro.svg" alt="Yes Hotel" width="66" height="32" />',
        concluido ? "" : '<div class="yh-header__side">' + langBtn + apto + "</div>",
        "</header>",
        progress,
        ocrBanner,
        '<main class="yh-main" id="v2-step-body">' + bodyHtml + "</main>",
        footer,
        sheetHtml(),
        "</div>",
      ].join("");

      document.documentElement.lang = state.lang === "es" ? "es" : state.lang === "en" ? "en" : "pt-BR";
      traduzirArvore(app, state.lang);
      updateDraftStatusEl();

      var back = document.getElementById("v2-back");
      if (back) back.addEventListener("click", goBack);
      var next = document.getElementById("v2-next");
      if (next) next.addEventListener("click", goNext);

      var body = document.getElementById("v2-step-body");
      if (body) {
        body.querySelectorAll("[data-field], [data-minor-field]").forEach(function (el) {
          el.addEventListener("input", function () {
            limparErroDoCampo(el);
            syncStateFromDom();
            if (el.getAttribute("data-field") === "meio_transporte") {
              render();
              return;
            }
            if (el.getAttribute("data-field") === "documento_tipo") {
              render();
              return;
            }
            if (el.getAttribute("data-minor-field") === "minor_relation") {
              render();
              return;
            }
            if (el.getAttribute("data-field") === "pais") {
              render();
              return;
            }
            scheduleDraft();
          });
          el.addEventListener("change", function () {
            syncStateFromDom();
            scheduleDraft();
            if (el.type === "checkbox" && campoDoErro() === "aceite") {
              if (state.data_confirmed && state.privacy_accepted) state.stepError = "";
              render();
            }
          });
        });
        body.querySelectorAll("[data-ext]").forEach(function (el) {
          el.addEventListener("input", function () {
            limparErroDoCampo(el);
            syncStateFromDom();
            scheduleDraft();
          });
        });
      }

      bindStepHandlers();
      bindSheet();

      // Etapa nova começa do topo; erro de validação leva até o campo.
      if (ultimoPassoRenderizado !== state.stepIndex) {
        ultimoPassoRenderizado = state.stepIndex;
        try {
          window.scrollTo(0, 0);
        } catch (_e) {
          /* ambiente sem scroll */
        }
      }
      if (state.scrollToError) {
        state.scrollToError = false;
        var alvo = app.querySelector(".is-invalid, #v2-step-error");
        if (alvo && alvo.scrollIntoView) {
          alvo.scrollIntoView({ block: "center" });
          if (alvo.focus && alvo.tagName !== "P") {
            try {
              alvo.focus({ preventScroll: true });
            } catch (_e2) {
              alvo.focus();
            }
          }
        }
      }
    }

    /** Ao corrigir o campo com erro, a mensagem sai sem redesenhar a etapa. */
    function limparErroDoCampo(el) {
      if (!el || !el.classList || !el.classList.contains("is-invalid")) return;
      el.classList.remove("is-invalid");
      el.removeAttribute("aria-invalid");
      var campo = el.closest ? el.closest(".yh-field") : null;
      if (campo) {
        campo.classList.remove("has-error");
        var msg = campo.querySelector(".yh-field-error");
        if (msg) msg.parentNode.removeChild(msg);
      }
      state.stepError = "";
    }

    function abrirIdioma(modo) {
      syncStateFromDom();
      state.langSheet = modo;
      render();
    }

    function bindSheet() {
      var lang = document.getElementById("yh-lang-btn");
      if (lang) {
        lang.addEventListener("click", function () {
          abrirIdioma("gerenciar");
        });
      }
      if (!state.langSheet) return;
      var fechar = function () {
        state.langSheet = "";
        render();
      };
      var fundo = document.getElementById("yh-sheet-backdrop");
      if (fundo) fundo.addEventListener("click", fechar);
      var cancelar = document.getElementById("yh-sheet-cancel");
      if (cancelar) cancelar.addEventListener("click", fechar);
      var brasil = document.getElementById("yh-sheet-brasil");
      if (brasil) {
        brasil.addEventListener("click", function () {
          aplicarResidencia(false);
          state.langSheet = "";
          state.stepError = "";
          render();
        });
      }
      app.querySelectorAll("[data-lang]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var escolhido = btn.getAttribute("data-lang");
          if (isBrazilResident(state)) {
            aplicarResidencia(true, escolhido);
          } else {
            state.lang = escolhido === "es" ? "es" : "en";
            salvarPrefs();
          }
          state.langSheet = "";
          state.stepError = "";
          render();
        });
      });
      var primeira = app.querySelector(".yh-sheet__opt");
      if (primeira) primeira.focus();
    }

    function bindStepHandlers() {
      var step = STEPS[state.stepIndex].id;

      if (step === "documento") {
        function wireHidden(inputId, side) {
          var input = document.getElementById(inputId);
          if (!input) return;
          input.addEventListener("change", function () {
            if (input.files && input.files[0]) uploadDocument(input.files[0], side);
            input.value = "";
          });
        }
        wireHidden("doc-camera-front", "front");
        wireHidden("doc-file-front", "front");
        wireHidden("doc-camera-back", "back");
        wireHidden("doc-file-back", "back");

        function wireTrigger(btnId, inputId) {
          var btn = document.getElementById(btnId);
          var input = document.getElementById(inputId);
          if (!btn || !input) return;
          btn.addEventListener("click", function () {
            input.click();
          });
        }
        wireTrigger("btn-doc-camera", "doc-camera-front");
        wireTrigger("btn-doc-file", "doc-file-front");
        wireTrigger("btn-doc-camera-back", "doc-camera-back");
        wireTrigger("btn-doc-file-back", "doc-file-back");
        wireTrigger("btn-doc-retake-file", "doc-file-front");

        var confira = document.getElementById("btn-goto-confira");
        if (confira) {
          confira.addEventListener("click", function () {
            goNext();
          });
        }

        // "Resido no exterior": ligar pergunta o idioma antes de mudar
        // qualquer coisa; desligar volta ao fluxo Brasil.
        var toggleDoc = document.getElementById("toggle-foreign-doc");
        if (toggleDoc) {
          toggleDoc.addEventListener("change", function () {
            if (toggleDoc.checked) {
              toggleDoc.checked = false;
              abrirIdioma("ativar");
            } else {
              aplicarResidencia(false);
              render();
            }
          });
        }
        var trocarIdioma = document.getElementById("yh-change-lang");
        if (trocarIdioma) {
          trocarIdioma.addEventListener("click", function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            abrirIdioma("gerenciar");
          });
        }
      }

      if (step === "confira_dados") {
        var escapeCpf = document.getElementById("btn-escape-exterior-cpf");
        if (escapeCpf) {
          escapeCpf.addEventListener("click", function () {
            abrirIdioma("ativar");
          });
        }
      }

      if (step === "endereco") {
        var cepInput = document.querySelector('[data-field="cep"]');
        if (cepInput) {
          var consultar = function () {
            syncStateFromDom();
            var d = digitsOnly(state.cep);
            if (d.length === 8 && !state.cepLoading && d !== ultimoCepConsultado) {
              ultimoCepConsultado = d;
              lookupCep();
            }
          };
          cepInput.addEventListener("input", consultar);
          cepInput.addEventListener("blur", consultar);
        }
        var escapeCep = document.getElementById("btn-escape-exterior-cep");
        if (escapeCep) {
          escapeCep.addEventListener("click", function () {
            abrirIdioma("ativar");
          });
        }
        var corrigir = document.getElementById("btn-corrigir-residencia");
        if (corrigir) {
          corrigir.addEventListener("click", function () {
            syncStateFromDom();
            aplicarResidencia(false);
            state.stepError = "";
            render();
          });
        }
      }

      if (step === "revisao") {
        app.querySelectorAll("[data-goto]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var alvo = indexOfStep(btn.getAttribute("data-goto"));
            if (alvo >= 0) {
              state.stepIndex = alvo;
              state.stepError = "";
              render();
            }
          });
        });
      }
    }

    var ultimoCepConsultado = "";

    function renderDocumento() {
      var needVerso = needsVersoAfterOcr();
      var hasAny =
        !!(state.has_document_upload || state.uploadedSides.front || state.uploadedSides.single);
      var analyzing = !!state.analyzing;
      var phase = state.analyzingPhase || "";
      var br = isBrazilResident(state);
      var recebido = hasAny && !needVerso && !analyzing;

      var processStatus = "";
      if (analyzing && phase === "upload") {
        processStatus = [
          '<div class="doc-process-status" role="status" aria-live="polite">',
          '  <div class="doc-process-status__row">',
          '    <span class="doc-spinner" aria-hidden="true"></span>',
          '    <span class="doc-process-status__title">Enviando documento…</span>',
          "  </div>",
          '  <p class="doc-process-status__hint">Aguarde um instante.</p>',
          "</div>",
        ].join("");
      } else if (analyzing) {
        processStatus = [
          '<div class="doc-process-status" role="status" aria-live="polite">',
          '  <div class="doc-process-status__row">',
          '    <span class="doc-spinner" aria-hidden="true"></span>',
          '    <span class="doc-process-status__title">Lendo documento…</span>',
          "  </div>",
          '  <p class="doc-process-status__hint">Estamos identificando seus dados automaticamente. Isso pode levar alguns segundos.</p>',
          "</div>",
        ].join("");
      } else if (recebido && state.showConfiraCta && state.ocrResultado !== "desligado") {
        var dica =
          state.ocrResultado === "completo"
            ? "Nome, documento e data de nascimento identificados."
            : state.ocrResultado === "parcial"
              ? "Alguns dados não foram identificados."
              : "Não identificamos dados neste arquivo. Você poderá preencher na próxima etapa.";
        processStatus = [
          '<div class="doc-process-status doc-process-status--done' +
            (state.ocrResultado === "completo" ? "" : " doc-process-status--partial") +
            '" role="status" aria-live="polite">',
          '  <p class="doc-process-status__title">Leitura concluída ✓</p>',
          '  <p class="doc-process-status__hint">' + dica + "</p>",
          "</div>",
        ].join("");
      } else if (recebido) {
        processStatus = [
          '<div class="doc-process-status doc-process-status--done" role="status" aria-live="polite">',
          '  <p class="doc-process-status__title">Documento enviado ✓</p>',
          state.ocrResultado === "desligado"
            ? '  <p class="doc-process-status__hint">Preencha seus dados na próxima etapa.</p>'
            : "",
          "</div>",
        ].join("");
      }

      var previewBlock = "";
      if (analyzing || recebido) {
        var nome = state.docPreviewName || "";
        var tipoArquivo = /\.pdf$/i.test(nome) ? "PDF" : nome ? "Imagem" : "";
        var chip = analyzing
          ? phase === "upload"
            ? "Enviando…"
            : "Documento recebido · lendo dados…"
          : "";
        previewBlock = [
          '<div class="doc-preview-card">',
          '  <div class="doc-preview-card__row">',
          '    <div class="doc-preview-thumb">',
          state.docPreviewUrl
            ? '<img class="doc-preview-img" src="' +
              escapeHtml(state.docPreviewUrl) +
              '" alt="Pré-visualização do documento" />'
            : '<span class="doc-preview-thumb__icon">' + ICON.file + "</span>",
          "    </div>",
          '    <div class="doc-preview-meta">',
          '      <p class="doc-preview-name">' + escapeHtml(nome || "Documento") + "</p>",
          tipoArquivo ? '      <p class="doc-preview-type">' + tipoArquivo + "</p>" : "",
          chip ? '      <span class="doc-chip doc-chip--busy">' + chip + "</span>" : "",
          "    </div>",
          "  </div>",
          processStatus ? '  <div class="doc-preview-card__status">' + processStatus + "</div>" : "",
          "</div>",
          analyzing
            ? ""
            : // Uma ação secundária só. O seletor de arquivo aceita imagem e
              // PDF e, no celular, o próprio sistema oferece a câmera --
              // então nada se perde ao fundir "tirar outra" e "trocar".
              '<button type="button" class="yh-link-btn" id="btn-doc-retake-file">Trocar documento</button>',
        ].join("");
      }

      function cartao(id, icone, titulo, dica, primario) {
        return [
          '<button type="button" class="doc-cta ' + (primario ? "doc-cta--primary" : "doc-cta--secondary") + '" id="' + id + '">',
          '  <span class="doc-cta__icon" aria-hidden="true">' + icone + "</span>",
          '  <span class="doc-cta__text">',
          '    <span class="doc-cta__title">' + titulo + "</span>",
          '    <span class="doc-cta__hint">' + dica + "</span>",
          "  </span>",
          '  <span class="doc-cta__chev" aria-hidden="true">' + ICON.chevron + "</span>",
          "</button>",
        ].join("");
      }

      // Depois da leitura, as capturas saem de cena: sobram "Conferir meus
      // dados" e uma única secundária para trocar o documento.
      var primaryCapture =
        analyzing || docLeituraConcluida()
          ? ""
          : needVerso
            ? cartao("btn-doc-camera-back", ICON.camera, "Tirar foto do verso", "Usar a câmera do celular", true) +
              cartao("btn-doc-file-back", ICON.upload, "Enviar verso do documento", "Escolha uma imagem ou PDF já salvo", false)
            : cartao("btn-doc-camera", ICON.camera, "Tirar foto do documento", "Usar a câmera do celular", true) +
              cartao("btn-doc-file", ICON.upload, "Enviar imagem ou PDF", "Escolher um arquivo já salvo no aparelho", false);
      // Documento já recebido (inclusive numa visita anterior): as duas
      // capturas não voltam; a troca é pelo "Trocar documento".
      if (recebido) primaryCapture = "";

      var titulo = recebido ? "Documento recebido" : "Seu documento";
      var lead = recebido
        ? state.ocrResultado === "desligado"
          ? "Confira e complete seus dados na próxima etapa."
          : "Leitura concluída. Confira os dados e complete o que faltar."
        : br
          ? "RG ou CNH. Tire uma foto ou envie um arquivo. Nós preenchemos os dados para você."
          : "Passaporte, identidade estrangeira ou documento Mercosul. Tire uma foto ou envie um arquivo. Nós preenchemos os dados para você.";

      var legenda = br
        ? '<span class="yh-switch__caption">English / Español disponíveis</span>'
        : '<span class="yh-switch__caption">' +
          (state.lang === "es" ? "Español" : "English") +
          ' · <button type="button" class="yh-inline-link" id="yh-change-lang">Alterar idioma</button></span>';

      var seletorExterior = [
        '<label class="yh-switch" for="toggle-foreign-doc">',
        '<span class="yh-switch__icon' + (br ? "" : " is-on") + '">' + ICON.globe + "</span>",
        '<span class="yh-switch__text"><span class="yh-switch__label">Resido no exterior</span>' + legenda + "</span>",
        '<input type="checkbox" class="yh-switch__input" id="toggle-foreign-doc" role="switch"' +
          (br ? "" : " checked") +
          " />",
        '<span class="yh-switch__track" aria-hidden="true"><span class="yh-switch__knob"></span></span>',
        "</label>",
      ].join("");

      return [
        introHtml(titulo, lead),
        // Inputs ocultos: câmera (capture) e arquivo (sem capture)
        '<input type="file" id="doc-camera-front" class="sr-only-file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" />',
        '<input type="file" id="doc-file-front" class="sr-only-file" accept="image/*,application/pdf" tabindex="-1" aria-hidden="true" />',
        '<input type="file" id="doc-camera-back" class="sr-only-file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true" />',
        '<input type="file" id="doc-file-back" class="sr-only-file" accept="image/*,application/pdf" tabindex="-1" aria-hidden="true" />',
        previewBlock,
        needVerso && !analyzing
          ? '<p class="yh-note">Este documento precisa do verso. Envie a segunda foto.</p>'
          : "",
        primaryCapture ? '<div class="doc-cta-stack">' + primaryCapture + "</div>" : "",
        primaryCapture ? '<p class="yh-tip">Dica: documento inteiro, com boa luz e sem reflexo.</p>' : "",
        '<div class="yh-spacer"></div>',
        seletorExterior,
      ].join("");
    }

    /**
     * HTML do aviso de OCR para uma etapa. Só "Confira dados" tem o que
     * conferir, e essa etapa desenha o próprio banner -- logo o shell nunca
     * desenha nenhum. Função nomeada para a regra ficar legível e testável.
     */
    /**
     * Etapa 1 tem dois estados, e só um conjunto de ações cabe em cada um:
     * ANTES da leitura, capturar/enviar; DEPOIS, conferir os dados (primária)
     * ou trocar o documento (secundária).
     *
     * Antes disso a tela somava os dois conjuntos e chegava a mostrar cinco
     * ações ao mesmo tempo, porque a renderização só olhava `analyzing`.
     */
    /** Índice de uma etapa por id; -1 quando não existe. */
    function indexOfStep(id) {
      for (var i = 0; i < STEPS.length; i++) {
        if (STEPS[i].id === id) return i;
      }
      return -1;
    }

    function docLeituraConcluida() {
      return !!state.showConfiraCta && !state.analyzing && !needsVersoAfterOcr();
    }

    function ocrBannerDaEtapa(stepId) {
      if (ETAPAS_COM_DADOS_DO_OCR.indexOf(stepId) < 0) return "";
      // "Confira dados" desenha o próprio banner; o shell não repete.
      if (stepId === "confira_dados") return "";
      if (!state.ocrBanner || state.analyzing) return "";
      return '<div class="banner" role="status">' + escapeHtml(state.ocrBanner) + "</div>";
    }

    function renderConfiraDados() {
      var br = isBrazilResident(state);
      var numLabel = documentoNumeroLabel(state.documento_tipo).replace(/\s*\*$/, "");

      var nome = campoHtml({
        key: "hospede_nome",
        label: "Nome completo",
        control: function (id, err, aria) {
          return inputTag(id, err, aria, 'data-field="hospede_nome" autocomplete="name"', state.hospede_nome);
        },
      });
      var social = campoHtml({
        key: "nome_social",
        label: "Nome social",
        optional: true,
        control: function (id, err, aria) {
          return inputTag(
            id,
            err,
            aria,
            'data-field="nome_social" placeholder="Como prefere ser chamado(a)"',
            state.nome_social,
          );
        },
      });
      var nascimento = campoHtml({
        key: "data_nascimento",
        label: "Data de nascimento",
        control: function (id, err, aria) {
          return inputTag(id, err, aria, 'data-field="data_nascimento" type="date" autocomplete="bday"', state.data_nascimento);
        },
      });
      var nacionalidade = campoHtml({
        key: "nacionalidade",
        label: "Nacionalidade",
        control: function (id, err, aria) {
          return inputTag(
            id,
            err,
            aria,
            'data-field="nacionalidade" placeholder="' + (br ? "ex.: Brasileira" : "ex.: Argentina") + '"',
            state.nacionalidade,
          );
        },
      });
      var tipo = campoHtml({
        key: "documento_tipo",
        label: "Tipo de documento",
        hint: br ? "" : "Não é preciso CPF.",
        control: function (id, err, aria) {
          return selectTag(
            id,
            err,
            aria,
            'data-field="documento_tipo"',
            '<option value="">Selecione…</option>' + optionHtml(docTypesFor(state), state.documento_tipo),
          );
        },
      });
      var numero = campoHtml({
        key: "documento_numero",
        label: numLabel,
        control: function (id, err, aria) {
          return inputTag(
            id,
            err,
            aria,
            'data-field="documento_numero" inputmode="' +
              (state.documento_tipo === "cpf" ? "numeric" : "text") +
              '" autocomplete="off"',
            state.documento_numero,
          );
        },
        // Atalho para quem não percebeu o seletor da Etapa 1: ativa o MESMO
        // estado global "Resido no exterior".
        after: br
          ? '<p class="yh-escape">Não possui CPF? <button type="button" class="yh-inline-link" id="btn-escape-exterior-cpf">Resido no exterior</button></p>'
          : "",
      });
      var paisEmissor = br
        ? ""
        : campoHtml({
            key: "pais_emissor",
            label: "País emissor do documento",
            control: function (id, err, aria) {
              var opcoes = opcoesPaises(state.pais_emissor, true, "");
              return opcoes
                ? selectTag(id, err, aria, 'data-field="pais_emissor" autocomplete="country-name"', opcoes)
                : inputTag(id, err, aria, 'data-field="pais_emissor" autocomplete="country-name"', state.pais_emissor);
            },
          });
      var telefone = campoHtml({
        key: "telefone",
        label: br ? "Celular com DDD" : "Celular com código do país",
        control: function (id, err, aria) {
          return inputTag(
            id,
            err,
            aria,
            'data-field="telefone" type="tel" autocomplete="tel" placeholder="' +
              (br ? "(00) 00000-0000" : "+1 416 555 0100") +
              '"',
            state.telefone,
          );
        },
      });
      var email = campoHtml({
        key: "email",
        label: "E-mail",
        hint: "Enviaremos por aqui as instruções de acesso.",
        control: function (id, err, aria) {
          return inputTag(id, err, aria, 'data-field="email" type="email" autocomplete="email"', state.email);
        },
      });

      return [
        introHtml("Seus dados", "Confira o que lemos do documento e complete o que faltar."),
        '<section class="yh-section" aria-labelledby="sec-voce">',
        '<h3 class="yh-section__title" id="sec-voce">Sobre você</h3>',
        nome,
        social,
        nascimento,
        br ? nacionalidade : "",
        "</section>",
        '<section class="yh-section" aria-labelledby="sec-doc">',
        '<h3 class="yh-section__title" id="sec-doc">Documento</h3>',
        // No exterior a nacionalidade decide o documento: vem primeiro.
        br ? "" : nacionalidade,
        tipo,
        numero,
        paisEmissor,
        "</section>",
        '<section class="yh-section" aria-labelledby="sec-contato">',
        '<h3 class="yh-section__title" id="sec-contato">Contato</h3>',
        telefone,
        email,
        "</section>",
      ].join("");
    }

    function renderEndereco() {
      var br = isBrazilResident(state);
      // A residência é decidida uma vez (Etapa 1 ou atalhos); aqui só se
      // reflete o que já foi dito, com um caminho discreto de correção.
      if (br) {
        var cepStatus = "";
        if (state.cepLoading) {
          cepStatus =
            '<p class="yh-status" role="status"><span class="doc-spinner" aria-hidden="true"></span><span>Buscando endereço…</span></p>';
        } else if (state.cepError) {
          cepStatus =
            '<p class="yh-field-error" role="alert">' + ICON.alert + "<span>" + escapeHtml(state.cepError) + "</span></p>";
        } else if (state.cepFound) {
          cepStatus = '<p class="yh-status yh-status--ok" role="status">' + ICON.check + "<span>Endereço encontrado</span></p>";
        }
        var cep = campoHtml({
          key: "cep",
          label: "CEP",
          tag: false,
          control: function (id, err, aria) {
            return inputTag(
              id,
              err,
              aria,
              'data-field="cep" inputmode="numeric" autocomplete="postal-code" maxlength="9" placeholder="00000-000"',
              state.cep,
            );
          },
          after:
            cepStatus +
            '<p class="yh-escape">Sem CEP brasileiro? <button type="button" class="yh-inline-link" id="btn-escape-exterior-cep">Resido no exterior</button></p>',
        });
        var simples = function (key, label, attrs, optional) {
          return campoHtml({
            key: key,
            label: label,
            optional: optional,
            tag: false,
            control: function (id, err, aria) {
              return inputTag(id, err, aria, attrs, state[key]);
            },
          });
        };
        return [
          introHtml("Onde você mora?", "Comece pelo CEP. O resto a gente completa."),
          '<section class="yh-section">',
          cep,
          simples("logradouro", "Rua", 'data-field="logradouro" autocomplete="address-line1"'),
          '<div class="yh-grid-2">',
          simples("numero", "Número", 'data-field="numero" autocomplete="address-line2"'),
          simples("complemento", "Complemento", 'data-field="complemento" placeholder="Apto, bloco"', true),
          "</div>",
          simples("bairro", "Bairro", 'data-field="bairro"'),
          '<div class="yh-grid-cidade">',
          simples("cidade", "Cidade", 'data-field="cidade" autocomplete="address-level2"'),
          simples("uf", "UF", 'data-field="uf" maxlength="2" placeholder="MS" autocomplete="address-level1"'),
          "</div>",
          '<input type="hidden" data-field="pais" value="Brasil" />',
          "</section>",
        ].join("");
      }

      var parte = function (key, label, attrs, optional) {
        return campoHtml({
          key: "ext_" + key,
          label: label,
          optional: optional,
          tag: false,
          control: function (id, err, aria) {
            return inputTag(id, err, aria, 'data-ext="' + key + '" ' + attrs, state.extPartes[key]);
          },
        });
      };
      var pais = campoHtml({
        key: "pais",
        label: "País",
        tag: false,
        control: function (id, err, aria) {
          var opcoes = opcoesPaises(state.pais === "Exterior" ? "" : state.pais, false, "Exterior");
          return opcoes
            ? selectTag(id, err, aria, 'data-field="pais" autocomplete="country-name"', opcoes)
            : inputTag(id, err, aria, 'data-field="pais" autocomplete="country-name"', state.pais === "Exterior" ? "" : state.pais);
        },
      });
      return [
        introHtml("Onde você mora?", "Seu endereço residencial."),
        '<section class="yh-section">',
        pais,
        parte("rua", "Rua e número", 'autocomplete="address-line1"'),
        parte("complemento", "Complemento", 'autocomplete="address-line2" placeholder="Apto, andar, unidade"', true),
        parte("cidade", "Cidade", 'autocomplete="address-level2"'),
        '<div class="yh-grid-2">',
        parte("regiao", "Estado / província", 'autocomplete="address-level1"', true),
        parte("postal", "Código postal", 'autocomplete="postal-code"', true),
        "</div>",
        '<p class="yh-escape">Mora no Brasil? <button type="button" class="yh-inline-link" id="btn-corrigir-residencia">Voltar ao fluxo Brasil</button></p>',
        "</section>",
      ].join("");
    }

    function renderViagem() {
      var isCar = String(state.meio_transporte || "").toLowerCase() === "carro";
      var simples = function (key, label, attrs, opts) {
        opts = opts || {};
        return campoHtml({
          key: key,
          label: label,
          optional: opts.optional,
          hint: opts.hint,
          tag: false,
          control: function (id, err, aria) {
            return inputTag(id, err, aria, attrs, state[key]);
          },
        });
      };
      var lista = function (key, label, attrs, options) {
        return campoHtml({
          key: key,
          label: label,
          tag: false,
          control: function (id, err, aria) {
            return selectTag(
              id,
              err,
              aria,
              attrs,
              '<option value="">Selecione…</option>' + optionHtml(options, state[key]),
            );
          },
        });
      };
      var vehicle = isCar
        ? [
            simples("placa_veiculo", "Placa do veículo", 'data-field="placa_veiculo" placeholder="ABC1D23" autocomplete="off"'),
            '<div class="yh-grid-2">',
            simples("cor_veiculo", "Cor do veículo", 'data-field="cor_veiculo"', { optional: true }),
            simples("modelo_veiculo", "Modelo do veículo", 'data-field="modelo_veiculo"', { optional: true }),
            "</div>",
          ].join("")
        : "";
      return [
        introHtml("Sobre sua viagem", "Só precisamos de algumas informações para completar sua ficha."),
        '<section class="yh-section">',
        lista("motivo_viagem", "Motivo da viagem", 'data-field="motivo_viagem"', MOTIVO_OPTIONS),
        lista("meio_transporte", "Meio de transporte", 'data-field="meio_transporte"', TRANSPORTE_OPTIONS),
        vehicle,
        simples("procedencia", "Procedência", 'data-field="procedencia" autocomplete="off"', {
          hint: "De onde você vem.",
        }),
        simples("destino", "Destino", 'data-field="destino" autocomplete="off" placeholder="Cidade para onde segue"'),
        "</section>",
      ].join("");
    }

    function renderMenores() {
      if (!state.minors.length) {
        return (
          introHtml("Menores sob sua responsabilidade", "") +
          '<p class="yh-lead">Não há menores vinculados a você nesta reserva. Toque em Continuar.</p>' +
          '<p class="yh-hint">Se houver crianças no grupo, elas devem estar cadastradas com você como responsável.</p>'
        );
      }
      return (
        introHtml(
          "Menores sob sua responsabilidade",
          "Confirme o parentesco e o acompanhamento de cada menor sob sua responsabilidade.",
        ) +
        state.minors
          .map(function (m, idx) {
            var other =
              m.minor_relation === "outro"
                ? '<div class="yh-field"><label class="yh-label" for="m-' +
                  idx +
                  '-outro">Descreva o parentesco</label>' +
                  '<input class="yh-input" id="m-' +
                  idx +
                  '-outro" data-minor-field="minor_relation_other" data-minor-index="' +
                  idx +
                  '" value="' +
                  escapeHtml(m.minor_relation_other) +
                  '" /></div>'
                : "";
            return [
              '<section class="yh-section yh-minor">',
              '  <h3 class="yh-section__title">' + escapeHtml(m.nome || "Menor") + "</h3>",
              m.data_nascimento
                ? '  <p class="yh-hint">' + escapeHtml(formatarData(m.data_nascimento)) + "</p>"
                : "",
              '  <div class="yh-field"><label class="yh-label" for="m-' + idx + '-rel">Parentesco</label>',
              '  <select class="yh-input yh-select" id="m-' + idx + '-rel" data-minor-field="minor_relation" data-minor-index="' + idx + '">',
              '  <option value="">Selecione…</option>',
              optionHtml(RELATION_OPTIONS, m.minor_relation),
              "  </select></div>",
              other,
              '  <div class="yh-field"><label class="yh-label" for="m-' + idx + '-acc">Acompanhamento</label>',
              '  <select class="yh-input yh-select" id="m-' + idx + '-acc" data-minor-field="minor_accompaniment" data-minor-index="' + idx + '">',
              '  <option value="">Selecione…</option>',
              optionHtml(ACCOMPANIMENT_OPTIONS, m.minor_accompaniment),
              "  </select></div>",
              "</section>",
            ].join("");
          })
          .join("")
      );
    }

    function renderRevisao() {
      var br = isBrazilResident(state);
      function corrigido(key) {
        return state.fieldOrigin && state.fieldOrigin[key] === "manual" && state.ocrKeys[key]
          ? ' <span class="yh-pill">corrigido</span>'
          : "";
      }
      function item(rotulo, valor, key, largo) {
        if (!hasText(valor)) return "";
        return (
          '<div class="yh-review-item' +
          (largo ? " yh-review-item--wide" : "") +
          '"><dt>' +
          escapeHtml(rotulo) +
          "</dt><dd><span>" +
          escapeHtml(valor) +
          "</span>" +
          (key ? corrigido(key) : "") +
          "</dd></div>"
        );
      }
      function grupo(id, titulo, alvo, corpo) {
        return (
          '<section class="yh-review-group" aria-labelledby="rev-' +
          id +
          '">' +
          '<div class="yh-review-group__head"><h3 id="rev-' +
          id +
          '">' +
          escapeHtml(titulo) +
          '</h3><button type="button" class="yh-alterar" data-goto="' +
          alvo +
          '" aria-describedby="rev-' +
          id +
          '">Alterar</button></div>' +
          corpo +
          "</section>"
        );
      }
      var tipoCurto =
        state.documento_tipo === "cpf"
          ? "CPF"
          : state.documento_tipo === "passport"
            ? "Passaporte"
            : state.documento_tipo === "other"
              ? "Documento estrangeiro"
              : "";

      var linhasEndereco;
      if (br) {
        linhasEndereco = [
          [state.logradouro, state.numero].filter(hasText).join(", "),
          state.complemento,
          [state.bairro, [state.cidade, state.uf].filter(hasText).join(", ")].filter(hasText).join(" · "),
          hasText(state.cep) ? "CEP " + formatarCep(state.cep) : "",
        ];
      } else if (hasText(state.extPartes.rua) || hasText(state.extPartes.cidade)) {
        var p = state.extPartes;
        linhasEndereco = [
          p.rua,
          p.complemento,
          [p.cidade, p.regiao].filter(hasText).join(", "),
          p.postal,
          state.pais !== "Exterior" ? state.pais : "",
        ];
      } else {
        linhasEndereco = [state.endereco_estrangeiro || state.endereco || ""];
      }
      var enderecoHtml = linhasEndereco
        .filter(hasText)
        .map(function (l) {
          return "<span>" + escapeHtml(l) + "</span>";
        })
        .join("");

      var minorsHtml = state.minors.length
        ? grupo(
            "menores",
            "Menores",
            "hospedes_menores",
            '<dl class="yh-review-list">' +
              state.minors
                .map(function (m) {
                  return item(m.nome || "Menor", labelOf(RELATION_OPTIONS, m.minor_relation), "", true);
                })
                .join("") +
              "</dl>",
          )
        : "";

      return [
        introHtml("Confira seus dados", "Revise as informações abaixo antes de continuar."),
        grupo(
          "pessoais",
          "Dados pessoais",
          "confira_dados",
          '<dl class="yh-review-list">' +
            item("Nome completo", state.hospede_nome, "hospede_nome", true) +
            item("Nome social", state.nome_social, "nome_social", true) +
            item("Nascimento", formatarData(state.data_nascimento), "data_nascimento") +
            item("Nacionalidade", state.nacionalidade, "nacionalidade") +
            "</dl>",
        ),
        grupo(
          "documento",
          "Documento",
          "confira_dados",
          '<dl class="yh-review-list">' +
            item("Tipo", tipoCurto, "documento_tipo") +
            item(state.documento_tipo === "cpf" ? "CPF" : "Número", state.documento_numero, "documento_numero") +
            (br ? "" : item("País emissor", state.pais_emissor, "pais_emissor", true)) +
            "</dl>",
        ),
        grupo(
          "contato",
          "Contato",
          "confira_dados",
          '<dl class="yh-review-list">' +
            item("Celular", state.telefone, "telefone", true) +
            item("E-mail", state.email, "email", true) +
            "</dl>",
        ),
        grupo("endereco", "Endereço", "endereco", '<p class="yh-review-address">' + enderecoHtml + "</p>"),
        grupo(
          "viagem",
          "Viagem",
          "viagem",
          '<dl class="yh-review-list">' +
            item("Motivo", labelOf(MOTIVO_OPTIONS, state.motivo_viagem)) +
            item("Transporte", labelOf(TRANSPORTE_OPTIONS, state.meio_transporte)) +
            (String(state.meio_transporte || "").toLowerCase() === "carro"
              ? item("Placa", state.placa_veiculo, "", true)
              : "") +
            item("Procedência", state.procedencia) +
            item("Destino", state.destino) +
            "</dl>",
        ),
        minorsHtml,
      ].join("");
    }

    function renderAceite() {
      var faltando = campoDoErro() === "aceite";
      var aviso =
        '<p class="yh-field-error yh-check-error" role="alert">' +
        ICON.alert +
        "<span>Marque este item para enviar.</span></p>";
      var caixa = '<span class="yh-check__box" aria-hidden="true">' + ICON.check + "</span>";
      return [
        introHtml("Confirme e aceite", "Leia os documentos abaixo e confirme para concluir seu check-in."),
        '<div class="yh-checks">',
        '<label class="yh-check' + (faltando && !state.data_confirmed ? " is-invalid" : "") + '">',
        '  <input type="checkbox" class="yh-check__input" data-field="data_confirmed"' +
          (state.data_confirmed ? " checked" : "") +
          " />",
        caixa,
        '  <span class="yh-check__text">Confirmo que os dados informados nesta ficha estão corretos e completos.</span>',
        "</label>",
        faltando && !state.data_confirmed ? aviso : "",
        '<label class="yh-check' + (faltando && !state.privacy_accepted ? " is-invalid" : "") + '">',
        '  <input type="checkbox" class="yh-check__input" data-field="privacy_accepted"' +
          (state.privacy_accepted ? " checked" : "") +
          " />",
        caixa,
        // Os links abrem em nova aba e NÃO são pré-requisito para marcar: o
        // conteúdo fica acessível, a decisão continua do hóspede. Nada muda na
        // semântica do aceite nem no que é persistido.
        "  <span class=\"yh-check__text\">Li e aceito os <a href=\"./termos-de-hospedagem.html\" target=\"_blank\" rel=\"noopener\">Termos de Hospedagem</a> " +
          "e o <a href=\"./aviso-de-privacidade.html\" target=\"_blank\" rel=\"noopener\">Aviso de Privacidade</a>.</span>",
        "</label>",
        faltando && !state.privacy_accepted ? aviso : "",
        "</div>",
        '<div class="yh-spacer"></div>',
        // Informação técnica: versões aceitas, com peso mínimo, longe das caixas.
        '<p class="yh-versions">Termos ' +
          escapeHtml(termsVersion).replace(/^terms-/, "") +
          " · Privacidade " +
          escapeHtml(privacyVersion).replace(/^privacy-/, "") +
          "</p>",
      ].join("");
    }

    function renderConcluido() {
      return [
        '<div class="yh-success" role="status">',
        '  <div class="yh-success__icon" aria-hidden="true"><span>' + ICON.check + "</span></div>",
        '  <div class="yh-success__head">',
        "  <h2>Cadastro concluído com sucesso</h2>",
        '  <span class="yh-success__rule" aria-hidden="true"></span>',
        "  <p>Os dados da sua FNRH foram atualizados com sucesso.</p>",
        "  </div>",
        "  <p>As credenciais de acesso e demais orientações serão enviadas em breve.</p>",
        '  <p class="yh-success__welcome">Seja bem-vindo(a) ao Yes Hotel.</p>',
        "</div>",
      ].join("");
    }

    function navOptsDaEtapa(id) {
      if (id === "documento") {
        var recebido = documentoRecebido() && !state.analyzing;
        return {
          footerNote: recebido
            ? null
            : '<p class="yh-footer-note">' + ICON.lock + "<span>Usado apenas para sua ficha de hospedagem</span></p>",
          primaryHtml: docLeituraConcluida()
            ? '<button type="button" class="yh-btn-primary" id="btn-goto-confira">Conferir meus dados<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>'
            : "",
        };
      }
      if (id === "revisao") {
        return {
          hideBack: true,
          afterHtml:
            '<button type="button" class="yh-btn-text yh-btn-text--block" id="v2-edit-start">Corrigir informações</button>',
        };
      }
      return {};
    }

    function render() {
      ensureVisibleStepIndex();
      var id = STEPS[state.stepIndex].id;
      var body = "";
      if (id === "documento") body = renderDocumento();
      else if (id === "confira_dados") body = renderConfiraDados();
      else if (id === "endereco") body = renderEndereco();
      else if (id === "viagem") body = renderViagem();
      else if (id === "hospedes_menores") body = renderMenores();
      else if (id === "revisao") body = renderRevisao();
      else if (id === "aceite") body = renderAceite();
      else body = renderConcluido();

      renderShell(body, navOptsDaEtapa(id));

      if (id === "revisao") {
        var edit = document.getElementById("v2-edit-start");
        if (edit) {
          edit.addEventListener("click", function () {
            // "Corrigir informações" leva aos dados pessoais (não ao envio do
            // documento): corrigir não é recomeçar.
            var alvo = indexOfStep("confira_dados");
            state.stepIndex = alvo >= 0 ? alvo : 0;
            state.stepError = "";
            render();
          });
        }
      }
    }

    render();
    setTimeout(doDraft, 400);
  }

  global.YesHotelFnrhCheckinV2 = { start: start, STEPS: STEPS };
})(typeof window !== "undefined" ? window : this);
