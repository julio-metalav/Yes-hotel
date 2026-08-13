# Yes Hotel — Contrato técnico TTLock (unificação)

Este documento é a **fonte única de verdade** para o comportamento da integração TTLock. Os dois pontos de chamada (Edge Function e app client) devem permanecer alinhados a este contrato.

## Content-Type e body

- **Sempre** usar `application/x-www-form-urlencoded` para as APIs de passcode:
  - `v3/keyboardPwd/add`
  - `v3/keyboardPwd/delete`
  - `v3/keyboardPwd/change`
- **Nunca** enviar JSON para essas rotas; a API TTLock pode devolver HTML/erro.
- Construir o body com `URLSearchParams` e enviar `params.toString()`.

## Delete (revogação)

- Endpoint: `POST {apiBase}/v3/keyboardPwd/delete`
- Parâmetros: `clientId`, `accessToken`, `lockId`, `keyboardPwdId`, `deleteType` = `"2"`, `date` (timestamp ms).
- Retry: **1 tentativa inicial + até 2 retries**; delay ~800 ms entre tentativas.
- Retry apenas para erros **transitórios**: status HTTP 5xx ou 429, ou códigos TTLock de token/rede (ex.: 10001–10004). Não repetir para 4xx ou erros de negócio.
- Ao esgotar tentativas: registrar falha final em log e propagar erro.

## Add (provisionamento)

- Endpoint: `POST {apiBase}/v3/keyboardPwd/add`
- Parâmetros: `clientId`, `accessToken`, `lockId`, `keyboardPwd`, `startDate`, `endDate`, `addType` = `2`, `date`; opcional `keyboardPwdName`.
- **Retry transitório (mesmo PIN):** timeout / network / HTTP 429 / 5xx / gateway temporário → retry do **mesmo** PIN (fase curta ~10s, até ~1 min com orçamento de sleep na Edge; fase 2 assíncrona via reentrada `lifecycle_provision`, até 5 ciclos ~1 min). **Não** gerar novo PIN.
- **Colisão -3007:** NÃO retry do mesmo PIN; fluxo de novo candidato + rollback parcial (quando aplicável).
- **Auth/config definitivo (401/credenciais inválidas/não configurado):** NÃO loop transitório.
- **Estado incerto (timeout após POST add):** reconciliar com `POST {apiBase}/v3/lock/listKeyboardPwd` (read-only). Se o PIN candidato existir, capturar `keyboardPwdId` e seguir. Se -3007 vier após incerteza, reconciliar antes de assumir colisão estrangeira.
- **2/3 OK + 3º transitório:** manter 1–2; retry do 3º com o mesmo PIN; credencial permanece `provisionando` (não `falhou`); sem `guest_access_ready`.
- Content-Type preferido: `application/x-www-form-urlencoded` (Edge). App client legado pode diferir; Edge é autoridade em produção.

## List (reconciliação)

- Endpoint: `POST {apiBase}/v3/lock/listKeyboardPwd`
- Parâmetros: `clientId`, `accessToken`, `lockId`, `pageNo`, `pageSize`, `date`.
- Uso: somente reconciliação / observabilidade — sem criar PIN.

## Limpeza pós-checkout (decisão operacional pendente)

- Arquitetura de revoke / `pendente_limpeza` / `retry_sync` já existe.
- **Não** ativar cron automático de limpeza neste hardening.
- Pendente decidir: quanto tempo após o checkout efetivo manter a credencial na TTLock antes do delete remoto (não assumir 4h automaticamente).

## Onde está implementado

- **Edge Function:** `supabase/functions/yes-hotel-lifecycle/index.ts` — `ttlockDeleteKeyboardPassword`, `ttlockAddKeyboardPassword`, `ttlockListKeyboardPasswords`.
- **App:** `src/lib/integrations/ttlock/client.ts` — `deleteKeyboardPassword`, `createKeyboardPassword`, `listKeyboardPasswords`.
- **Domínio:** `src/lib/domain/yes-hotel/ttlock-provision-retry.ts` — classificação de erro + retry mesmo PIN + reconciliação.

Qualquer alteração em content-type, serialização, retry ou tratamento de erro deve ser feita nos dois pontos e refletida neste documento.

## Limpeza posterior (janela até 2h pós-checkout)

- A senha expira no horário (ex.: 11h); o delete remoto é saneamento operacional.
- Itens com `status_provisionamento = 'pendente_limpeza'` e `remote_keyboard_pwd_id` não nulo estão **pendentes de limpeza remota** (delete ainda não confirmado).
- `revogado` + `revogado_em` = **apenas** quando o delete remoto for confirmado com sucesso. Falha no delete → `pendente_limpeza` + `ultimo_erro`; não preencher `revogado_em`.
- A Edge Function ao ser chamada com `retry_sync` (ou ao processar uma credencial revogada) tenta novamente o delete para itens `pendente_limpeza`.
- Ação `list_pending_cleanup`: retorna lista de credenciais com quantidade de itens pendentes de limpeza.

## Item sem passcode remoto (remote_keyboard_pwd_id nulo)

- Item que nunca foi provisionado no TTLock (ou sem `remote_keyboard_pwd_id`) **não tem delete remoto a confirmar**.
- No checkout/revogação esses itens podem ser marcados com `status_provisionamento = 'revogado'` e `revogado_em` preenchido: é **encerramento apenas local**, não "delete remoto confirmado".
- Em código e contratos: tratar explicitamente como "revogado local / sem confirmação remota" para não confundir com remoção confirmada na TTLock.
