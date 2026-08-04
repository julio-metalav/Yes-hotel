# Integração oficial HITS — Yes Hotel

## Objetivo

Preparar a integração server-side com a API HITS PMS para, quando a HITS fornecer o shared access secret e habilitar o módulo, o Yes Hotel poder:

1. configurar secrets;
2. autenticar (`POST /Authorize`);
3. consultar propriedades;
4. consultar reservas do Web Check-In-Out;
5. consultar detalhes de uma reserva;
6. futuramente registrar check-in factual após o primeiro uso válido da senha na porta do apartamento.

## Estado atual

**Preparada e desativada.**

- `HITS_INTEGRATION_ENABLED=false` (default)
- `HITS_CHECKIN_ENABLED=false` (default)
- Nenhum secret criado no Supabase nesta etapa
- Nenhuma Edge implantada
- Nenhuma migration
- Nenhuma chamada real à API HITS nos testes desta preparação
- Contrato de **request body** do CheckIn: `unverified` (Swagger não declara `requestBody`)

Código: `src/lib/integrations/hits/`

## Endpoints oficiais preparados

Fonte: [https://api.hitspms.net/](https://api.hitspms.net/) · Swagger V1 `https://api.hitspms.net/swagger/v1/swagger.json`

| Método | Rota | Uso |
|---|---|---|
| POST | `/Authorize` | Token de acesso |
| GET | `/api/HealthCheck` | Saúde |
| GET | `/Datashare/Properties` | Propriedades |
| GET | `/Datashare/WebCheckinOut/Reservations` | Lista Web Check-In-Out |
| GET | `/Datashare/WebCheckinOut/Reservation/{id}` | Detalhe |
| POST | `/Datashare/Folios/{reservationId}/CheckIn` | Check-in (bloqueado até flags + contrato) |

Não implementados nesta etapa: IncludePayment, hóspedes, documento, checkout, cancelamento.

## Schemas oficiais

- `HitsPms.ApiGateway.Security.AccessSecret` — `{ secret, propertyId, scopes }`
- `HitsPms.ApiGateway.Security.AccessToken` — `{ token, party }`
- `HitsPms.ApiGateway.V1.Models.WebCheckIn.WebCheckInListDto`
- `HitsPms.ApiGateway.V1.Models.WebCheckIn.ReservationDetailDto`
- `HitsPms.ApiGateway.V1.Models.Folios.CheckInDto` — resposta `{ folioId, roomCode }`

Autenticação em rotas Datashare: `securitySchemes.Token` = **HTTP Bearer**.

## Variáveis

| Variável | Default | Notas |
|---|---|---|
| `HITS_API_BASE_URL` | `https://api.hitspms.net` | Sem trailing slash |
| `HITS_SHARED_ACCESS_SECRET` | (vazio) | Somente server-side |
| `HITS_PROPERTY_ID` | (vazio) | UUID no body AccessSecret |
| `HITS_INTEGRATION_ENABLED` | `false` | Só `"true"` ativa |
| `HITS_CHECKIN_ENABLED` | `false` | Exige também integração ativa |
| `HITS_REQUEST_TIMEOUT_MS` | `12000` | Conservador |

Headers Datashare (preencher após confirmação HITS):

- `HITS_API_VERSION` (default `1`)
- `HITS_TENANT_NAME`
- `HITS_PROPERTY_CODE`
- `HITS_PARTNER_USER_ID`
- `HITS_CLIENT_ID`
- `HITS_LANGUAGE_CODE` (default `pt-BR`)
- `HITS_AUTHORIZE_SCOPES` (CSV; default interno `WebCheckIn`)

**Proibido:** qualquer `NEXT_PUBLIC_HITS_*`.

## Flags

- Integração ativa ↔ `HITS_INTEGRATION_ENABLED === "true"`
- Check-in efetivo ↔ integração ativa **e** `HITS_CHECKIN_ENABLED === "true"`
- Com integração desligada, nenhum método executa `fetch`

## Fluxo de autenticação

1. Montar body `AccessSecret`: `secret`, `propertyId`, `scopes` (ex.: `["WebCheckIn"]`)
2. `POST /Authorize` com header `X-API-VERSION`
3. Receber `AccessToken`: `token`, `party`
4. Guardar token **somente em memória**
5. Chamadas Datashare: `Authorization: Bearer <token>` + headers de contexto

Token/secret nunca são logados, persistidos ou retornados em erros.

## Fluxo de leitura

1. `authorize()` (ou sessão em memória)
2. `listProperties` / `listWebCheckinReservations` / `getWebCheckinReservation`
3. Mapper existente (`mapper.ts`) traduz DTO HITS → domínio interno Yes (sem acoplar tabelas ao DTO)

## Gate de check-in

`evaluateHitsCheckInEligibility` (policy pura):

- integração/check-in desligados → bloqueia
- sem `hits_reservation_id` → bloqueia
- somente `first_room_access_confirmed` + `access_method === "room_passcode"` → permite
- portão / app / admin / cartão / chave → bloqueiam
- já checked-in / cancelada / encerrada → bloqueiam
- pagamento pendente **não** bloqueia
- FNRH pendente **não** bloqueia
- suspensão posterior de acesso **não** desfaz check-in (fora desta policy)

## Primeiro acesso factual

O check-in HITS só deve ser considerado após confirmação do primeiro uso válido da senha na **porta do apartamento** (pipeline TTLock / first-room-access do Yes). Portões não disparam check-in.

## Pagamento / FNRH

Pendências de pagamento ou FNRH **não** impedem o check-in factual no HITS nesta regra de negócio.

## Idempotência

Tipo `HitsCheckInOperation` (sem migration nesta etapa):

- `operation = "hits_checkin"`
- `idempotency_key` sem dados pessoais
- statuses: `pending | processing | succeeded | failed | already_checked_in | manual_review`
- sem duas operações simultâneas para o mesmo primeiro acesso
- persistência em PR posterior; **nenhum check-in ativado antes disso**

Além disso, o cliente bloqueia mutação enquanto `checkInBodyContractStatus === "unverified"`.

## Segurança

- Shared secret só server-side
- Sem `NEXT_PUBLIC_*`
- Erros sanitizados (`HitsError` / `sanitizeUnknown`)
- Transporte com timeout, AbortController, retry só em 429/5xx/timeout
- Sem retry em 400/401/403/409

## O que ainda falta (depende da HITS)

1. Shared access secret
2. Habilitação contratual da API
3. Confirmação do módulo Web Check-In-Out
4. `propertyId` oficial (UUID)
5. Valores de tenant / property code / partner user / client id
6. Ambiente de homologação
7. Confirmação se `POST .../CheckIn` aceita body (hoje só response `CheckInDto`)
8. Efeitos operacionais do check-in (status, folio, diária, financeiro, housekeeping, auditoria)
9. Comportamento em duplicidade / rate limits / códigos de erro
10. Persistência de `HitsCheckInOperation`

## Checklist de ativação

1. HITS habilitar API para o Yes Hotel
2. Receber shared access secret
3. Confirmar `propertyId`
4. Confirmar ambiente de homologação
5. Habilitar Web Check-In-Out
6. Confirmar contrato exato de `/Authorize` (já alinhado ao Swagger V1)
7. Confirmar `CheckInDto` / body de request
8. Explicar efeitos do check-in (status, folio, diária, financeiro, housekeeping, auditoria)
9. Informar duplicidade
10. Informar rate limits
11. Informar códigos de erro
12. Informar identificação do usuário/origem da integração
13. Preencher envs server-side (sem commit de secret)
14. Ligar `HITS_INTEGRATION_ENABLED=true` só em homologação controlada
15. Só então avaliar `HITS_CHECKIN_ENABLED=true` após persistência de idempotência

## Testes

```bash
npm run test:hits:integration-prep
```

Suite 100% mockada (fetch injetável). Não requer secret nem rede.

## Relação com código legado

Existia um cliente preliminar com body `{ accessSecret }` e envs `HITS_BASE_URL` / `HITS_ACCESS_SECRET`. Essa leitura **divergia** do schema oficial `AccessSecret`. A preparação atual corrige o contrato conforme Swagger e mantém aliases/`mapper.ts` para o domínio interno.
