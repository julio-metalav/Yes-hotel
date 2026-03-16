# Yes Hotel — MVP 3 Fase 2 — Outbound mínimo: deploy e teste

## Arquivos criados/alterados

- **Criado:** `supabase/functions/send-whatsapp-message/index.ts` — Edge Function de envio outbound com adaptador mock.
- **Alterado:** `ui/comunicacao-mvp.js` — `sendMessage()` passa a chamar o endpoint quando `conv.canal === 'whatsapp'`; conversas com canal diferente mantêm insert direto (status 'local').
- **Criado:** `docs/YES_HOTEL_COMUNICACAO_MVP_3_FASE_2_DEPLOY_E_TESTE.md` — Este arquivo.

## Comportamento do mock

- **Sucesso:** por padrão o adaptador retorna `{ ok: true, provider_message_id: "mock-" + timestamp }`. A mensagem é gravada com `status_envio = 'enviada'` e o `provider_message_id` é salvo.
- **Falha de teste:** se o texto contiver `__fail__`, o mock retorna `{ ok: false, error: "..." }`. A mensagem fica com `status_envio = 'falha'` e o erro em `metadata`.

## Deploy da Edge Function

```bash
cd D:\Automação_Yes_Hotel
supabase functions deploy send-whatsapp-message
```

Requisitos: projeto linkado; variáveis `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` (as duas últimas são injetadas pelo Supabase no deploy). A função usa o anon key para validar o JWT do usuário e o service role para escrever no banco.

URL após deploy: `https://<PROJECT_REF>.supabase.co/functions/v1/send-whatsapp-message`

## Exemplo de curl para testar envio

Obter um JWT de sessão (ex.: após login na UI, copiar o token do localStorage `yesHotelSupabaseAccessToken` ou usar o token retornado pelo Supabase Auth). Substituir `PROJECT_REF` e `SEU_JWT`:

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/send-whatsapp-message" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SEU_JWT" \
  -d "{\"conversa_id\": \"UUID_DA_CONVERSA\", \"text\": \"Teste outbound Fase 2.\"}"
```

Resposta esperada (sucesso): `{"ok":true,"messageId":"...","provider_message_id":"mock-..."}`

## Como testar falha mock

Enviar texto contendo `__fail__`:

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/send-whatsapp-message" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SEU_JWT" \
  -d "{\"conversa_id\": \"UUID_DA_CONVERSA\", \"text\": \"Mensagem __fail__ para simular erro.\"}"
```

Resposta esperada: `{"ok":false,"error":"Mock: falha simulada ...","messageId":"..."}`. No banco, a mensagem com esse `messageId` deve ter `status_envio = 'falha'` e `metadata` com o erro.

Na UI: digitar uma mensagem que contenha `__fail__` e clicar Enviar; deve aparecer alert de falha e a mensagem na lista com status de falha (se a UI exibir status).

## Validar no banco

Após envio com sucesso:

```sql
select id, conversa_id, direcao, tipo_mensagem, mensagem, status_envio, provider_message_id
from public.comunicacao_mensagens
where direcao = 'saida'
order by created_at desc limit 5;
```

Esperado: `status_envio = 'enviada'` e `provider_message_id` começando com `mock-`.

Após envio com falha mock (`__fail__`):

```sql
select id, status_envio, metadata from public.comunicacao_mensagens
where status_envio = 'falha' order by created_at desc limit 3;
```

Esperado: `metadata` com campo `error` descrevendo a falha simulada.

## Validar na UI

1. Abrir a Central de Comunicação e fazer login.
2. Selecionar uma conversa com canal WhatsApp (ex.: a conversa do seed com telefone 5511999990001 — canal 'whatsapp').
3. Digitar uma mensagem e clicar Enviar.
4. Esperado: mensagem aparece no chat como saída; lista de conversas atualiza o preview; sem erro.
5. Digitar uma mensagem contendo `__fail__` e enviar.
6. Esperado: alert de falha; mensagem aparece na lista com status de falha (ou a mensagem é exibida e o status 'falha' pode ser conferido no banco).

A UI já carrega `status_envio` das mensagens; pode-se exibir um indicador visual de "Enviada" / "Falha" ao lado da bolha se desejar (opcional nesta fase).
