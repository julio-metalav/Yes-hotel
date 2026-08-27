# Homologação PAX (Sandbox HITS)

Roteiro manual da escrita controlada de hóspede. **Não** colar secret, token, nome real, documento, contato, endereço ou JSON completo do HITS em ticket, chat ou evidência.

Escopo: inclusão/vínculo e atualização cadastral de PAX. Fora deste roteiro: check-in, no-show, TTLock, UI e produção.

Trava: a escrita só ocorre se, ao mesmo tempo:

- configuração HITS completa;
- `HITS_TENANT_NAME=develop` (maiúsculas/minúsculas irrelevantes);
- `HITS_GUEST_WRITE_ENABLED=true` (exato).

Caso contrário o gateway responde `403` / `guest_write_disabled`.

Base: `https://hits-homo.yeshotel.com.br` (ou o host HOMO vigente). Auth: `Authorization: Bearer $GATEWAY_TOKEN`.

Use IDs sintéticos ou mascarados nas notas (`reservationId=***`, `idEntity=***`).

## 1. GET inicial (reserva)

```bash
curl -sS -D - \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "$BASE/v1/reservations/{reservationId}"
```

Esperado: `200`. Confirme que a reserva existe. Não copie o body para evidência.

## 2. Pesquisa para evitar duplicidade

```bash
curl -sS -D - \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "$BASE/v1/guests?DocType=2&Doc={doc}"
```

Se já houver `idEntity` para o mesmo documento, **não** faça POST de inclusão. Siga para o PUT (passo 5) se a atualização for necessária.

Filtros úteis (allowlist): `EntityId`, `Since`, `DocType`, `Doc`, `Email`, `Page`, `Size`.

## 3. POST — incluir/vincular PAX na reserva

```bash
curl -sS -D - \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"guests":[{"name":"...","doc":"...","docType":2,"contact":"...","contactType":2}]}' \
  "$BASE/v1/reservations/{reservationId}/guests"
```

Destino HITS: `POST /Datashare/WebCheckinOut/Guests/{reservationId}`.

- `reservationId` só no path. Não enviar `idEntity`.
- `name` obrigatório. `doc`+`docType` juntos; `contact`+`contactType` juntos.
- Sem retry automático.

Esperado: `200` com `{"ok":true,"request_id":"..."}`. O body do HITS não é reencaminhado. `403 guest_write_disabled` = trava ainda desligada. `401` = token ausente/errado.

## 4. GET para obter idEntity

```bash
curl -sS -D - \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "$BASE/v1/guests?DocType=2&Doc={doc}"
```

Anote apenas `idEntity` e `idReservation` mascarados. Sem dump do hóspede.

Alternativa: detalhe da reserva `GET /v1/reservations/{reservationId}` e localizar o PAX em `guests[]`.

## 5. PUT — atualizar cadastro

```bash
curl -sS -D - \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"idEntity":1,"idReservation":1,"name":"..."}' \
  "$BASE/v1/guests"
```

Destino HITS: `PUT /Datashare/WebCheckinOut/Guests`.

Obrigatório: `idEntity` e `idReservation` inteiros positivos, e ao menos um campo de atualização.

Esperado: `200` com `{"ok":true,"request_id":"..."}`. Sem PAX, documento, contato ou JSON upstream. `422 hits_validation_failed` = HITS 400. `409 hits_conflict` = conflito HITS.

## 6. GET final

Repita o GET de hóspede ou o detalhe da reserva. Confirme que o PAX está vinculado, sem gravar o payload.

## Evidências sem PII

Registrar só:

- `x-request-id`;
- operação (`guest_post` / `guest_put` / GET);
- HTTP status;
- `code` sanitizado (`guest_write_disabled`, `hits_validation_failed`, `hits_conflict`, etc.).

Não registrar: body de request/response, nome, documento, contato, endereço, token, secret.

## Desligar a flag após o teste

1. Remover ou esvaziar `HITS_GUEST_WRITE_ENABLED` no env do serviço (`/etc/hits-gateway/hits-gateway.env`).
2. Recarregar o processo (`systemctl restart hits-gateway` no HOMO, quando for o caso).
3. Confirmar com um POST autenticado: esperado `403` / `guest_write_disabled`.
4. Não deixar a flag `true` ligada em produção. Tenant diferente de `develop` já bloqueia a escrita.
