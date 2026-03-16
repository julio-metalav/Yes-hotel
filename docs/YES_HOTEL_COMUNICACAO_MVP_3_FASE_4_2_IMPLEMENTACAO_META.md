# Yes Hotel — MVP 3 WhatsApp — Fase 4.2 — Implementação Meta Cloud API

Implementação técnica da integração com Meta Cloud API mantendo mock e fallback para testes manuais.

## Variáveis de ambiente

| Variável | Uso |
|----------|-----|
| `WHATSAPP_USE_MOCK` | `true` = mock (padrão); `false` = Meta Cloud API real (outbound) |
| `WHATSAPP_ACCESS_TOKEN` | Bearer token para envio (obrigatório quando USE_MOCK=false) |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID na URL de envio (obrigatório quando USE_MOCK=false) |
| `WHATSAPP_GRAPH_API_VERSION` | Opcional; default `v21.0` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Comparado com `hub.verify_token` no GET de verificação |
| `WHATSAPP_APP_SECRET` | Validação de `X-Hub-Signature-256` no POST (se ausente, assinatura não é validada) |

Definir no Supabase: **Project Settings → Edge Functions → Secrets** (ou `.env` local para testes).

## Deploy das functions

```bash
cd D:\Automação_Yes_Hotel
supabase functions deploy webhook-whatsapp-inbound
supabase functions deploy send-whatsapp-message
```

Configurar os secrets antes do deploy em produção:

```bash
supabase secrets set WHATSAPP_USE_MOCK=false
supabase secrets set WHATSAPP_ACCESS_TOKEN=...
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...
supabase secrets set WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
supabase secrets set WHATSAPP_APP_SECRET=...
```

## Testes

### 1. Mock (padrão)

- `WHATSAPP_USE_MOCK=true` ou variável ausente.
- Enviar mensagem pela UI: continua usando mock; `provider_message_id` no formato `mock-<timestamp>`.

### 2. Outbound real (USE_MOCK=false)

- Definir `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_USE_MOCK=false`.
- Enviar mensagem pela UI: a função chama `POST https://graph.facebook.com/{version}/{PHONE_NUMBER_ID}/messages`.
- Verificar no celular/número de teste e que `provider_message_id` foi gravado em `comunicacao_mensagens`.

### 3. GET challenge (verificação do webhook Meta)

- URL: `GET https://<seu-projeto>.supabase.co/functions/v1/webhook-whatsapp-inbound?hub.mode=subscribe&hub.verify_token=<WHATSAPP_WEBHOOK_VERIFY_TOKEN>&hub.challenge=abc123`
- Resposta esperada: **200**, body texto = `abc123` (Content-Type: text/plain).
- Token errado: **403**.

### 4. POST da Meta (payload real)

- Configurar no painel Meta a URL do webhook e o mesmo `verify_token`.
- A Meta envia POST com body no formato `object: "whatsapp_business_account"`, `entry[]`, `changes[]`, `value.messages[]` / `value.statuses[]`.
- O webhook valida `X-Hub-Signature-256` quando `WHATSAPP_APP_SECRET` está definido; em seguida processa mensagens e status e chama os handlers existentes.

### 5. Teste manual / fallback

- POST direto no webhook com body **fora** do formato Meta (sem `object`/`entry`):
  - **Inbound:** `{ "from": "5511999990001", "messageId": "test-1", "text": "Olá" }` → mesmo fluxo de antes.
  - **Status:** `{ "type": "status", "provider_message_id": "mock-123", "status": "entregue" }` → atualiza `status_envio`.
- Quando `WHATSAPP_APP_SECRET` não está definido, a assinatura não é validada (útil para testes locais com payload manual).

## Resumo do que foi implementado

- **send-whatsapp-message:** adapter real `cloudApiAdapterSend`; escolha mock vs real por `WHATSAPP_USE_MOCK`.
- **webhook-whatsapp-inbound:** GET com hub.mode/verify_token/challenge; POST com body raw, validação de assinatura opcional; reconhecimento de payload Meta (entry/changes/value) para inbound e status; fallback para payload de teste manual.

Nenhuma migration; arquitetura e UI inalteradas.
