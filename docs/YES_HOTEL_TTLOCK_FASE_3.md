# Yes Hotel — Fase TTLock 3: Ciclo de vida da credencial

## Objetivo da fase

Implementar **revogação**, **alteração de validade** e **reprovisionamento** da credencial TTLock, com tratamento operacional para cancelamento, checkout, early check-in, late check-out, troca de apartamento e ajuste manual. O sistema passa a administrar o ciclo de vida completo do acesso (criar, alterar, revogar, reprovisionar) com rastreabilidade.

## O que foi implementado

- **Adaptador TTLock:** `deleteKeyboardPassword` (revogação remota) e `changeKeyboardPassword` (alteração de validade/passcode) implementados; `deleteType=2` e `changeType=2` (via gateway).
- **Migration 0008:** campos `revogado_em` e `motivo_revogacao` na tabela `operacional_credenciais_acesso`.
- **Repositório:** `getCredencialPorReserva`, `getItens`, `getItensProvisionados`, `insertItem`, `getReservaApartment`, `getFechadurasForApartment`; atualização de credencial/item com `revogado_em`, `motivo_revogacao`, `valido_de`, `valido_ate`.
- **Credential lifecycle** (`credential-lifecycle.ts`):
  - `revokeCredential(credencialId, deps, motivo)` — revoga passcode remoto por item e atualiza estados.
  - `updateCredentialValidity(credencialId, deps, { valido_de, valido_ate })` — altera validade na credencial e no TTLock (change passcode).
  - `reprovisionCredential(credencialId, deps)` — revoga itens atuais e provisiona itens pendentes (mesmo passcode).
  - `handleCancellation(reservaId, deps)` — revoga credencial da reserva (motivo cancelamento).
  - `handleCheckout(reservaId, deps)` — revoga credencial (motivo checkout).
  - `handleEarlyCheckin(credencialId, deps, novoValidoDe)` — antecipa início da validade.
  - `handleLateCheckout(credencialId, deps, novoValidoAte)` — estende fim da validade.
  - `handleRoomChange(reservaId, deps, novoApartamento)` — revoga itens do apt/bloco antigo, insere itens do novo apartamento e provisiona (mesmo passcode).
  - `handleManualAdjustment(credencialId, deps, { revogar?, valido_de?, valido_ate?, reprovisionar? })` — ajuste manual.
- **Scripts de debug:** `debug:ttlock-revoke`, `debug:ttlock-update-validity`, `debug:ttlock-reprovision`, `debug:ttlock-lifecycle`.

## Fluxos suportados

| Cenário           | Handler / uso                                      | Comportamento resumido                                                                 |
|------------------|-----------------------------------------------------|----------------------------------------------------------------------------------------|
| Cancelamento     | `handleCancellation(reservaId)`                     | Localiza credencial da reserva; revoga todos os itens no TTLock; credencial → revogada. |
| Checkout         | `handleCheckout(reservaId)`                         | Idem, motivo checkout.                                                                |
| Early check-in   | `handleEarlyCheckin(credencialId, novoValidoDe)`    | Altera validade no TTLock (change) e na credencial.                                    |
| Late check-out   | `handleLateCheckout(credencialId, novoValidoAte)`   | Altera validade no TTLock (change) e na credencial.                                    |
| Room change      | `handleRoomChange(reservaId, novoApartamento)`      | Revoga itens do apartamento/bloco antigo; insere itens do novo apt; provisiona (mesmo passcode). |
| Ajuste manual   | `handleManualAdjustment(credencialId, { ... })`     | Revogar e/ou alterar validade e/ou reprovisionar conforme opções.                     |

## Estratégia de alteração de validade

- A Open Platform TTLock oferece **v3/keyboardPwd/change** com `startDate` e `endDate` (changeType=2, via gateway).
- O adaptador chama `changeKeyboardPassword` com a nova janela; a credencial e os itens são atualizados no banco com `valido_de` e `valido_ate`.
- Se a API falhar em algum item, o erro é registrado em `ultimo_erro` e a credencial continua com a validade atualizada localmente (rastreabilidade).

## Estratégia de revogação

- Para cada item com `status_provisionamento = provisionado` e `remote_keyboard_pwd_id` preenchido, chama **v3/keyboardPwd/delete** (deleteType=2).
- Em seguida atualiza o item: `status_provisionamento = revogado`, `revogado_em = now()`.
- Quando todos os itens estão revogados (ou sem vínculo remoto), a credencial é atualizada: `status = revogada`, `revogado_em`, `motivo_revogacao`.
- Se o TTLock não estiver disponível, a revogação é apenas local (item marcado revogado com mensagem em `ultimo_erro`).

## Estratégia de reprovisionamento

- **reprovisionCredential:** primeiro revoga todos os itens provisionados (remoto + estado local); em seguida chama o executor de provisionamento para os itens **pendentes** (mesmo passcode da credencial quando já existir).
- **Room change:** revoga apenas itens do apartamento/bloco antigo; insere novos itens para o novo apartamento (via `getFechadurasForApartment`); provisiona os novos itens com o mesmo passcode.

## Regras por cenário

- **Cancelamento:** credencial não pode permanecer “ativa”; remoto revogado quando possível; falha de API registrada para retry/ação manual.
- **Checkout:** mesmo que cancelamento; motivo = checkout.
- **Early check-in / Late check-out:** mesma credencial; apenas alteração de validade (change no TTLock).
- **Room change:** nunca deixar acesso ao apartamento antigo ativo; novo apartamento provisionado com portões do bloco correto; mesmo passcode quando possível.
- **Ajuste manual:** executado por script/serviço; sem UI nova; rastreável e documentado.

## Limitações conhecidas (Open Platform TTLock)

- Delete e Change exigem fechaduras com passcode V4 e gateway (deleteType/changeType=2).
- Resposta da API é errcode/errmsg; falhas devem ser tratadas por código e mensagem.
- Não há “update parcial” de apenas início ou apenas fim; change envia startDate e endDate (ambos podem ser enviados).

## Scripts criados

| Script                         | Comando                                                                 | Descrição |
|--------------------------------|-------------------------------------------------------------------------|-----------|
| Revogar credencial             | `npm run debug:ttlock-revoke -- <credencial_id> [motivo]`               | Revoga passcode remoto e atualiza estados. |
| Alterar validade               | `npm run debug:ttlock-update-validity -- <credencial_id> <valido_de> <valido_ate>` | Atualiza janela de validade no TTLock e no banco. |
| Reprovisionar                  | `npm run debug:ttlock-reprovision -- <credencial_id>`                   | Revoga itens atuais e provisiona pendentes. |
| Cenários de ciclo de vida      | `npm run debug:ttlock-lifecycle -- <cenario> [args...]`                 | cancellation, checkout, early-checkin, late-checkout, room-change, manual-revoke, manual-validity. |

Exemplos:

```bash
npm run debug:ttlock-lifecycle -- cancellation <reserva_id>
npm run debug:ttlock-lifecycle -- checkout <reserva_id>
npm run debug:ttlock-lifecycle -- early-checkin <credencial_id> 2025-03-19T13:00:00Z
npm run debug:ttlock-lifecycle -- late-checkout <credencial_id> 2025-03-23T14:00:00Z
npm run debug:ttlock-lifecycle -- room-change <reserva_id> 12
npm run debug:ttlock-lifecycle -- manual-revoke <credencial_id>
npm run debug:ttlock-lifecycle -- manual-validity <credencial_id> 2025-03-20T13:00:00Z 2025-03-22T11:00:00Z
```

## Checklist de validação manual

- [ ] Aplicar migration 0008 no projeto Supabase.
- [ ] Revogar credencial: itens passam a revogado e credencial a revogada; remoto sem passcode quando TTLock disponível.
- [ ] Alterar validade: credencial e itens com nova janela; TTLock reflete nova validade (quando API disponível).
- [ ] Reprovisionar: itens antigos revogados; itens pendentes provisionados com mesmo passcode.
- [ ] Room change: apartamento antigo sem acesso; novo apartamento + portões do bloco provisionados; mesmo passcode.
- [ ] Cancelamento/checkout: credencial revogada e motivo persistido; sem estado “ativo” após sucesso.

## Próximo passo sugerido após a Fase 3

- Integrar os handlers ao fluxo do painel (ex.: ao marcar “cancelada” ou “checkout” na reserva, chamar `handleCancellation`/`handleCheckout` via backend ou função).
- Opcional: job/rotina que processa “encerramento de estadia” por data e chama checkout para reservas encerradas.
- Manter scripts de debug para suporte e testes de regressão.
