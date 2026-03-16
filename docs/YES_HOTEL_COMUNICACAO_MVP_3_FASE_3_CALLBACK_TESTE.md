# Yes Hotel — MVP 3 Fase 3 — Callback de status: teste manual

## Arquivos alterados

- **Alterado:** `supabase/functions/webhook-whatsapp-inbound/index.ts` — Tratamento de POST com `type: 'status'`: localiza mensagem por `provider_message_id`, aplica precedência (enviada < entregue < lida), UPDATE em `status_envio`, evento opcional, 200.
- **Criado:** `docs/YES_HOTEL_COMUNICACAO_MVP_3_FASE_3_CALLBACK_TESTE.md` — Este arquivo.

## Contrato do callback de status

POST para a **mesma URL** do webhook inbound, com body indicando que é evento de status:

- **Detecção:** `type === 'status'` ou `event === 'status'` ou `kind === 'status'`.
- **Campos:** `provider_message_id` (obrigatório), `status` (obrigatório: `entregue`, `lida` ou `falha`).
- **Alternativas aceitas:** `provider_message_id` pode vir como `message_id` ou `id`; `status` pode vir como `delivered`/`delivery` → entregue, `read`/`read_at` → lida, `failed`/`error` → falha.

## Exemplo de curl — status = entregue

Substituir `PROJECT_REF` e usar um `provider_message_id` real (ex.: o retornado ao enviar mensagem pela UI na Fase 2, ex. `mock-1734567890123`):

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/webhook-whatsapp-inbound" \
  -H "Content-Type: application/json" \
  -d "{\"type\": \"status\", \"provider_message_id\": \"mock-1734567890123\", \"status\": \"entregue\"}"
```

Resposta esperada: HTTP 200 (corpo vazio).

## Exemplo de curl — status = lida

```bash
curl -X POST "https://PROJECT_REF.supabase.co/functions/v1/webhook-whatsapp-inbound" \
  -H "Content-Type: application/json" \
  -d "{\"type\": \"status\", \"provider_message_id\": \"mock-1734567890123\", \"status\": \"lida\"}"
```

Resposta esperada: HTTP 200.

## Teste de duplicata / fora de ordem

1. **Duplicata:** Enviar o mesmo curl de status (ex.: entregue) duas vezes. Esperado: 200 em ambos; no banco a mensagem continua com `status_envio = 'entregue'` (sem duplicar linha).
2. **Fora de ordem:** Enviar primeiro `status: "lida"` e depois `status: "entregue"`. Esperado: primeiro UPDATE para lida; segundo não regride (shouldUpdateStatus retorna false), estado final permanece `lida`.
3. **Ordem correta:** Enviar `entregue` e depois `lida`. Esperado: primeiro entregue, depois lida; estado final `lida`.

## Validar no banco

Após enviar callback de entregue:

```sql
select id, conversa_id, direcao, status_envio, provider_message_id
from public.comunicacao_mensagens
where provider_message_id = 'mock-1734567890123';
```

Esperado: `status_envio = 'entregue'` (ou `lida` se já tiver enviado esse callback).

Eventos:

```sql
select id, conversa_id, tipo_evento, payload, created_at
from public.comunicacao_eventos
where tipo_evento = 'status_atualizado'
order by created_at desc limit 5;
```

## Validar na UI após reload

1. Abrir a Central de Comunicação e a conversa que contém a mensagem.
2. Recarregar a página (F5).
3. A lista de mensagens já carrega `status_envio` do banco; a mensagem de saída deve refletir o status atualizado (entregue/lida) se a UI exibir esse campo. Caso a UI não mostre ainda um rótulo de status, o valor estará correto no banco e pode ser exposto em fase posterior.

## Fluxo de teste completo

1. Enviar uma mensagem pela UI (conversa WhatsApp) → anotar o `provider_message_id` da resposta (ou consultar no banco: `select provider_message_id from comunicacao_mensagens where direcao = 'saida' order by created_at desc limit 1`).
2. Enviar callback entregue (curl com esse provider_message_id) → conferir no banco `status_envio = 'entregue'`.
3. Enviar callback lida (mesmo id) → conferir `status_envio = 'lida'`.
4. Enviar de novo callback entregue (duplicata) → conferir que permanece `lida` (não regride).
5. Recarregar a UI e confirmar que a mensagem aparece com o status correto (se a tela exibir status).
