# Yes Hotel - Orquestrador Operacional V1

## Objetivo da camada

Centralizar a coordenacao operacional interna do Yes Hotel em uma funcao unica que receba um contexto de evento e devolva um plano operacional padronizado, pronto para logs, painel futuro, persistencia futura e integracoes futuras.

## Como se encaixa na arquitetura

- o core continua concentrando as regras de acesso, janela e targets
- os adaptadores continuam convertendo fontes externas para `InternalReservation`
- o orquestrador coordena essas pecas e devolve um objeto operacional unico para consumo da aplicacao

## Diferenca entre core, adaptador e orquestrador

- core: calcula regras de acesso e credencial
- adaptador: traduz payload externo para modelo interno
- orquestrador: escolhe o fluxo operacional certo por evento e organiza o resultado final

## Eventos suportados

- `reservation_created`
- `reservation_updated`
- `reservation_canceled`
- `room_changed`
- `manual_adjustment`

## Arquivos criados

- `src/lib/application/yes-hotel/types.ts`
- `src/lib/application/yes-hotel/orchestrator.ts`
- `src/lib/application/yes-hotel/format.ts`
- `src/lib/application/yes-hotel/index.ts`
- `scripts/test-yes-orchestrator-created.ts`
- `scripts/test-yes-orchestrator-room-change.ts`
- `scripts/test-yes-orchestrator-cancel.ts`
- `scripts/test-yes-orchestrator-manual-adjustment.ts`

## Decisoes de comportamento por evento

- `reservation_created`: gera provisionamento inicial, janela e preview de credencial
- `reservation_updated`: faz reavaliacao conservadora da reserva atual, sem detectar diferencas estruturais finas
- `reservation_canceled`: gera plano de revogacao e omite preview de credencial
- `room_changed`: exige reserva anterior, revoga acessos antigos e provisiona os novos
- `manual_adjustment`: recalcula janela com ajuste manual e mantem os targets da reserva atual

## Limitacoes atuais

- nao ha persistencia
- nao ha integracoes externas
- `reservation_updated` ainda nao faz diff detalhado de estado
- o plano ainda e voltado para simulacao e preparacao da camada futura de aplicacao

## Proximos passos

1. conectar este plano operacional a uma camada futura de persistencia
2. conectar depois a uma fila/log operacional
3. usar o mesmo formato como base para painel e integracoes futuras
