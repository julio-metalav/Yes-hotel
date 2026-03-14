# Yes Hotel - Adaptador HITS Mock V1

## Objetivo da camada

Criar uma camada de adaptacao entre um payload externo em formato estilo HITS e o modelo interno `InternalReservation` do Yes Hotel, mantendo o core operacional desacoplado da origem dos dados.

## Contrato externo x modelo interno

- o payload estilo HITS representa a fonte externa
- `InternalReservation` representa o contrato interno minimo do Yes
- o `access-engine` continua dependendo apenas de `InternalReservation`
- trocar HITS mock por HITS real deve afetar apenas a camada de adaptacao, e nao o core operacional

## Arquivos criados

- `src/lib/integrations/hits-mock/types.ts`
- `src/lib/integrations/hits-mock/mapper.ts`
- `src/lib/integrations/hits-mock/index.ts`
- `src/lib/integrations/hits-mock/fixtures/normal.ts`
- `src/lib/integrations/hits-mock/fixtures/room-change.ts`
- `src/lib/integrations/hits-mock/fixtures/cancel.ts`
- `src/lib/integrations/hits-mock/fixtures/index.ts`
- `scripts/test-hits-mock-to-yes-normal.ts`
- `scripts/test-hits-mock-to-yes-room-change.ts`
- `scripts/test-hits-mock-to-yes-cancel.ts`

## Cenarios mockados

- reserva normal
- troca de apartamento
- cancelamento

## Fallbacks adotados

- quarto principal: usa o primeiro item de `rooms[]` quando nao ha sinalizacao mais forte
- hospede principal: usa `guest.main = true` quando existir
- fallback de hospede: se nao houver `main = true`, usa o primeiro hospede compativel com `room.idRoom`
- fallback final de hospede: se ainda assim nao houver correspondencia clara, usa o primeiro item de `guests[]`
- `updatedAt`: usa `dateUp` como preferencial e cai para `dateAdd` se `dateUp` estiver ausente
- `status`: faz mapeamento minimo e conservador para `confirmed`, `canceled`, `in_house`, `checked_out` ou `unknown`

## Limitacoes atuais

- as fixtures sao mockadas e pequenas
- a escolha do quarto principal ainda e conservadora e simples
- o mapeamento de status externo ainda e minimo
- ainda nao ha leitura do HITS real
- ainda nao ha tratamento de casos complexos com multiplos quartos ou multiplos hospedes principais

## O que deve mudar quando ligar no HITS real

- a origem dos payloads
- eventuais ajustes finos no mapeamento de status
- eventuais ajustes na escolha do quarto principal, caso o payload real traga sinalizacao adicional
- validacoes extras de contrato conforme a resposta autenticada real

## O que NAO deve mudar quando ligar no HITS real

- o modelo interno `InternalReservation`
- o `access-engine`
- o catalogo operacional e as regras de provisionamento/revogacao do core
- a ideia de manter a origem externa desacoplada do nucleo do Yes

## Como rodar

```bash
npm run test:hits-mock:normal
npm run test:hits-mock:room-change
npm run test:hits-mock:cancel
```
