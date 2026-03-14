# Yes Hotel - Adaptador HITS Real V1

## Objetivo da camada

Preparar a adaptacao da resposta real do cliente HITS V1 para o modelo interno `InternalReservation`, sem depender ainda de autenticacao real funcionando.

## Diferenca entre adaptador mock e adaptador real

- o adaptador mock recebe fixtures controladas em `src/lib/integrations/hits-mock/`
- o adaptador real recebe o tipo `HitsReservationDetail` da integracao HITS existente
- ambos devolvem `InternalReservation`
- o `access-engine` continua identico e desacoplado da origem externa

## Arquivos criados/alterados

- `src/lib/integrations/hits/mapper.ts`
- `src/lib/integrations/hits/index.ts`
- `fixtures/hits-real-sample-detail.json`
- `scripts/test-hits-real-json-to-yes.ts`
- `package.json`

## Fallbacks adotados

- quarto principal: usa o primeiro item de `rooms[]` quando nao houver criterio mais confiavel confirmado
- hospede principal: usa `guest.main === true`
- fallback de hospede: usa o primeiro guest compativel com `room.idRoom`
- fallback final: usa o primeiro guest disponivel
- `updatedAt`: usa `dateUp`, com fallback para `dateAdd`
- `apartmentCode`: extrai os digitos de `rooms[].code` e valida de forma conservadora no intervalo operacional atual do hotel
- `status`: faz mapeamento minimo a partir de `room.status`, retornando `confirmed`, `canceled`, `in_house`, `checked_out` ou `unknown`

## Como testar com JSON local

Usando o sample padrao:

```bash
npm run test:hits-real:json
```

Usando um arquivo salvo localmente:

```bash
npm run test:hits-real:json -- --file ./fixtures/hits-real-sample-detail.json
```

O script executa:

- leitura do JSON bruto
- parse para `HitsReservationDetail`
- adaptacao para `InternalReservation`
- execucao do `access-engine`
- impressao do plano resultante

## Limitacoes atuais

- ainda nao ha chamada autenticada real ao HITS
- o sample JSON e controlado e representa apenas um caso simples
- o mapeamento de status ainda e minimo
- a escolha do quarto principal continua conservadora para cenarios com multiplos quartos

## O que muda quando a auth real estiver disponivel

- a origem do payload, que passara a vir do cliente HITS em vez de um arquivo JSON
- a validacao final do contrato real de resposta
- possiveis ajustes finos no mapeamento de status e selecao de quarto principal

## O que NAO deve mudar quando a auth real estiver disponivel

- o modelo interno `InternalReservation`
- o `access-engine`
- a separacao entre camada externa de integracao e nucleo interno do Yes
- a estrategia de adaptar a resposta externa antes de entrar no core
