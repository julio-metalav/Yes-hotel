# Yes Hotel — MVP 3 Fase 1 — Webhook inbound: deploy e teste

## Arquivos criados/alterados

- **Criado:** `supabase/functions/webhook-whatsapp-inbound/index.ts` — Edge Function do webhook inbound.
- **Criado:** `docs/YES_HOTEL_COMUNICACAO_MVP_3_FASE_1_WEBHOOK_DEPLOY_E_TESTE.md` — Este arquivo.

## Contrato aceito nesta etapa (teste manual)

O webhook aceita POST JSON com um dos formatos abaixo (adapter mínimo):

**Formato interno (recomendado para teste):**

```json
{
  "from": "5511999990001",
  "messageId": "id-unico-da-mensagem",
  "text": "Texto da mensagem recebida"
}
```

**Campos alternativos aceitos:** `from` pode vir como `phone`, `sender`, `from_number`; `messageId` como `id`, `message_id`, `provider_message_id`; `text` como `body`, `message`, `content`. O campo `from` é normalizado para E.164 sem "+" (ex.: `+5511999990001` → `5511999990001`).

---

## Como fazer deploy da Edge Function

1. **Pré-requisito:** Migration 0013 aplicada no projeto Supabase (índice único em `canal`, `telefone`).

2. **Supabase CLI** (com projeto linkado):
   ```bash
   cd D:\Automação_Yes_Hotel
   supabase functions deploy webhook-whatsapp-inbound
   ```

3. **Variáveis:** A função usa `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`, injetadas automaticamente pelo Supabase no deploy. Não é necessário configurar secrets adicionais para a Fase 1.

4. **URL após o deploy:**
   ```
   https://<PROJECT_REF>.supabase.co/functions/v1/webhook-whatsapp-inbound
   ```
   Substitua `<PROJECT_REF>` pelo ref do projeto no dashboard do Supabase (Project Settings → General → Reference ID).

---

## Exemplo de POST de teste via curl

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/webhook-whatsapp-inbound" \
  -H "Content-Type: application/json" \
  -d "{\"from\": \"5511999990001\", \"messageId\": \"test-msg-001\", \"text\": \"Bom dia, gostaria de informações sobre reserva.\"}"
```

**Teste de idempotência (mesmo messageId não duplica):**

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/webhook-whatsapp-inbound" \
  -H "Content-Type: application/json" \
  -d "{\"from\": \"5511999990001\", \"messageId\": \"test-msg-001\", \"text\": \"Repetido.\"}"
```

Ambos devem retornar **200**; no banco deve existir apenas **uma** mensagem com `provider_message_id = 'test-msg-001'`.

**Nova conversa (outro telefone):**

```bash
curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/webhook-whatsapp-inbound" \
  -H "Content-Type: application/json" \
  -d "{\"from\": \"5521988880000\", \"messageId\": \"test-msg-002\", \"text\": \"Olá, quero fazer uma reserva.\"}"
```

---

## Como validar no banco que funcionou

1. **Conversas:**  
   `select id, canal, telefone, status, ultima_mensagem_em, ultima_mensagem_preview from public.comunicacao_conversas order by ultima_mensagem_em desc nulls last;`  
   Deve aparecer uma linha por telefone testado, com `ultima_mensagem_preview` e `ultima_mensagem_em` preenchidos.

2. **Mensagens:**  
   `select id, conversa_id, direcao, tipo_mensagem, mensagem, provider_message_id, created_at from public.comunicacao_mensagens order by created_at desc;`  
   Deve aparecer uma linha por POST com `direcao = 'entrada'` e `provider_message_id` igual ao enviado. Repetir o mesmo `messageId` não deve criar nova linha.

3. **Eventos (opcional):**  
   `select id, conversa_id, tipo_evento, payload, created_at from public.comunicacao_eventos where tipo_evento = 'mensagem_recebida' order by created_at desc;`

---

## Como validar na UI que funcionou

1. Abrir a Central de Comunicação:  
   `https://yes-hotel.vercel.app/comunicacao-mvp.html` (ou o ambiente local equivalente).
2. Fazer login com um usuário interno.
3. Recarregar a página (F5) para atualizar a lista de conversas.
4. A conversa do número testado deve aparecer na lista (nome/telefone e preview da última mensagem).
5. Clicar na conversa: a mensagem recebida via webhook deve aparecer no chat como entrada.

Nenhuma alteração na UI foi necessária: ela já lê `comunicacao_conversas` e `comunicacao_mensagens` do banco; o webhook apenas persiste os dados.
