# Yes Hotel — Fonte da verdade: comunicação, WhatsApp e automações

Este documento é **normativo** para o projeto. Em caso de conflito com outros materiais, **prevalece o que está aqui** até nova decisão explícita.

---

## 1. Decisões fechadas

| Tema | Decisão |
|------|---------|
| **Meta Cloud API** | **Não** será usada **diretamente** pelo Yes Hotel. |
| **Canal WhatsApp** | **DigiSac** é o canal operacional de WhatsApp. |
| **Tipo de conexão DigiSac** | Conexão **não oficial**, via **QR Code** (sessão/bridge típica de soluções não-Business API oficial). |
| **Papel do Yes Hotel** | O Yes continua sendo o **cérebro das automações**: regras, dados operacionais, FNRH, e-mail, TTLock, painel, reservas, integração HITS e orquestração do que deve acontecer e quando. |
| **Papel da DigiSac** | Execução do **canal WhatsApp** (envio/recebimento na prática operacional), alinhada a políticas da DigiSac e aos limites da conexão por QR. |

---

## 2. Princípios de automação (obrigatórios)

Por causa da conexão **não oficial** e do **baixo nível de garantia** típico desse modelo:

1. **Cautela:** priorizar confiabilidade e previsibilidade sobre volume de mensagens.
2. **Baixo volume:** apenas mensagens **essenciais** ao fluxo (ex.: lembretes críticos, senha/acesso quando acordado, reenvio de link FNRH se política aprovar).
3. **Sem dependência frágil:** o fluxo operacional **não pode falhar** se o WhatsApp (DigiSac) estiver indisponível; e-mail e painel permanecem como canais de contingência e registro.
4. **Rastreabilidade:** o núcleo Yes deve continuar registrando **eventos e estado** (timeline, envios de e-mail, provisionamento TTLock, status FNRH), independentemente de a mensagem WhatsApp ter sido disparada pela DigiSac ou manualmente.

---

## 3. Escopo técnico implicado

### 3.1 Dentro do Yes (cérebro)

- Definição de **quando** notificar (gatilhos alinhados a reserva, FNRH, pagamento, liberação de acesso, etc.).
- Persistência e consulta no **Supabase** (operacional, FNRH, credenciais, eventos).
- **E-mail** transacional (ex.: Resend) para links FNRH e, quando aplicável, senha/instruções.
- **TTLock** (lifecycle, provisionamento, revogação).
- **Painel** interno e, quando existir, **API ou fila** que informe à DigiSac **o que** enviar (payload mínimo, template interno ou texto), sem acoplar Meta Cloud API.

### 3.2 Fora ou na borda (DigiSac / QR)

- Entrega efetiva no WhatsApp do hóspede, respeitando limites da sessão QR e políticas da DigiSac.
- Conversas humanas e exceções que não precisam ser modeladas no Yes.

### 3.3 Legado no repositório (não é caminho de produção para esta decisão)

- Implementações voltadas à **Meta Cloud API** direta (ex.: variáveis `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, webhooks Meta no modelo oficial integrado ao Yes).
- Podem permanecer no código para testes ou histórico, desde que **não** sejam a base da operação acordada aqui.

---

## 4. Integração futura Yes ↔ DigiSac (diretriz)

Quando houver integração técnica:

- Deve ser **desacoplada**: contrato mínimo (ex.: evento + telefone + texto ou template ID **interno** DigiSac).
- **Rate limiting** e fila do lado Yes ou middleware, coerentes com baixo volume e cautela.
- **Não** substituir o registro de eventos no Yes por “apenas enviar no WhatsApp”.

Detalhes de API DigiSac, credenciais e mapeamento de templates ficam em documento de **integração técnica** específico, derivado deste.

---

## 5. Documentos relacionados

- Plano de entrega operacional: `PLANO_01_A_05_ENTREGA.md`
- Arquitetura geral (complementar; comunicação normativa aqui): `YES_HOTEL_FONTE_DA_VERDADE_ARQUITETURA.md`
- MVP comunicação / fases Meta nos docs antigos: tratados como **histórico ou legado**, salvo onde explicitamente atualizados para referenciar este arquivo.

---

## 6. Changelog desta fonte da verdade

| Data | Alteração |
|------|-----------|
| 2026-04-05 | Criação: Meta Cloud API fora do Yes; DigiSac via QR; Yes como cérebro; automação cautelosa e essencial. |
