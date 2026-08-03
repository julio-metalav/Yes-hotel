# TTLock Access Ingest — primeiro acesso / tolerância (PR3)

## Objetivo

Receber **Lock Records Notify** da TTLock, sanitizar o payload, correlacionar com
credencial/reserva e acionar o orquestrador de primeiro acesso (PR2), **sem**
enviar mensagens, suspender senhas ou chamar a API TTLock.

## Callback URL futura (NÃO configurar ainda)

Quando autorizado em homologação:

```text
https://<PROJECT_REF>.supabase.co/functions/v1/ttlock-access-ingest?secret=<TTLOCK_ACCESS_WEBHOOK_SECRET>
```

Preferir também header (se a plataforma permitir customizar):

```http
X-Yes-Hotel-Ttlock-Webhook-Secret: <TTLOCK_ACCESS_WEBHOOK_SECRET>
```

Resposta exigida pela TTLock: corpo texto plano `success`.

Referência: [Lock Records Notify](https://euopen.ttlock.com/doc/api/v3/lockRecord/notify) (corpo `"success"`).

## Feature flag

| Variável | Default | Comportamento |
|---|---|---|
| `YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED` | ausente / ≠ `true` | **Desativado**: autentica, responde `success`, log sanitizado `ingest_disabled`, **não** persiste nem processa |

Ativar em homologação somente com valor exato:

```bash
YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED=true
```

Desligar imediatamente: remover a variável ou definir qualquer valor diferente de `true`.

## Autenticação e `verify_jwt`

### JWT do gateway Supabase

Em `supabase/config.toml`, **somente** a função `[functions.ttlock-access-ingest]` recebeu
`verify_jwt = false` neste PR (outras Edges já tinham a flag por motivos próprios;
**nenhuma outra Edge foi alterada** neste diff).

Motivo: callback público da TTLock não envia JWT Supabase. A autenticação da Edge
depende de `TTLOCK_ACCESS_WEBHOOK_SECRET`, não de sessão Auth.

### Segredo do callback

A TTLock **não** documenta assinatura HMAC nativa do Notify.

Estratégia Yes Hotel:

1. **Segredo forte** `TTLOCK_ACCESS_WEBHOOK_SECRET` (nunca reutilizar `TTLOCK_CLIENT_SECRET`).
2. **Preferencial:** header `x-yes-hotel-ttlock-webhook-secret`.
3. **Fallback de compatibilidade:** query `?secret=` (risco de vazamento em logs de proxy/CDN).
4. Comparação em tempo constante.
5. `TTLOCK_ACCESS_WEBHOOK_IP_ALLOWLIST` (CSV) apenas como defesa **complementar** — nunca única.

### Comportamento flag × auth

| Flag | Sem segredo / segredo inválido | Segredo válido |
|---|---|---|
| **desligada** | HTTP 200 + corpo `success`; **não** revela se o segredo está certo ou errado; não persiste | Idem (mesmo status/corpo) |
| **ligada** | HTTP 401; **não** processa | Processa (se ports/migrations ok) |

Com a flag **ligada**, a Edge **não** aceita requisições sem segredo válido.

**Risco:** quem conhecer URL+secret pode forjar eventos. Mitigar com secret longo, rotação e, no futuro, reconciliação por polling.

## Secrets necessários

| Secret | Uso |
|---|---|
| `TTLOCK_ACCESS_WEBHOOK_SECRET` | Auth do callback |
| `TTLOCK_ACCESS_IDEMPOTENCY_SECRET` | HMAC da `idempotency_key` (dedicado; fallback local no webhook secret) |
| `SUPABASE_SERVICE_ROLE_KEY` | Persistência (Edge) |
| `YES_HOTEL_TTLOCK_ACCESS_INGEST_ENABLED` | Flag |

Não usar `TTLOCK_CLIENT_SECRET` para webhook nem idempotência.

## Payload esperado

```json
{
  "lockId": 15615492,
  "lockMac": "AA:BB:CC:DD:EE:FF",
  "records": [
    {
      "recordType": 4,
      "success": 1,
      "username": "optional",
      "keyboardPwd": "123456",
      "lockDate": 1723123456789,
      "serverDate": 1723123457000,
      "electricQuantity": 80
    }
  ]
}
```

Limites: 64 KB de corpo; no máximo 50 records.

## Sanitização

`raw_payload_sanitized` e logs **nunca** incluem:

- `keyboardPwd` / senha
- tokens, secrets, headers de auth, query secret
- dados pessoais desnecessários

Permitidos (exemplos): `lockId`, `lockMac` mascarado, `recordType`, `success`, `lockDate`, `serverDate`, `electricQuantity`, `username` mascarado.

`keyboardPwd` só em memória na correlação; descartado após o processamento.

## Idempotência

- `source_event_id`: ID nativo se existir; senão `ttlock_notify:{lockId}:{lockDate}:{recordType}:{success}:{index}` (polling futuro usa prefixo `ttlock_polling:`).
- `idempotency_key`: HMAC-SHA256 com segredo dedicado sobre `lockId|lockDate|recordType|success|[pwdDigest]`.
- Notify e polling do **mesmo** evento físico devem gerar a **mesma** `idempotency_key` (sem prefixo de fonte na key).
- UNIQUE em `(source, source_event_id)` e em `idempotency_key` (migration 0022).

## Duplicidade Notify + polling

Polling futuro (`lockRecord/list`) deve reutilizar `buildIdempotencyKey` sem alterar o material. O segundo caminho encontra o evento pela key e não reinicia tolerância.

## Correlação

1. Itens `provisionado` no `lockId`
2. Destino lógico apartamento (`APT-*`)
3. Credencial não revogada + reserva
4. Se `keyboardPwd`: comparação tempo-constante com `codigo_credencial` (memória)
5. Se `remote_keyboard_pwd_id` disponível e único, pode desambiguar
6. Múltiplas candidatas → `ambiguous` (não escolhe; não inicia tolerância)

## Atomicidade

Ver [FIRST_ROOM_ACCESS_TRANSACTION.md](./FIRST_ROOM_ACCESS_TRANSACTION.md) (PR5).

- Persistência integral via RPC `yes_hotel_process_first_room_access` (migration **0025**, não aplicada).
- RPC 0023 (`yes_hotel_create_access_tolerance`) ficou **obsoleta** para o fluxo completo.
- Outbox de fila: `operacional_acesso_outbox` (não `operacional_comunicacao_envios`).
- **Não existe** fallback de múltiplos inserts independentes.
- Evento / outbox / markProcessed fora da RPC antiga = lacuna resolvida no desenho PR5 (ainda requer aplicar 0022+0025).

## Migrations (NÃO aplicadas neste PR)

- `0022_operacional_primeiro_acesso_tolerancia.sql`
- `0023_first_room_access_create_tolerance_rpc.sql`
- `0024_operacional_hospedes_fnrh_roles.sql`
- `0025_first_room_access_transactional_rpc.sql`

## Proibições

- Não logar `keyboardPwd`
- Não persistir senha
- Não configurar Callback URL até ordem explícita
- Não ativar flag em produção sem homologação
- Não polling/cron/DigiSac/suspensão neste PR
