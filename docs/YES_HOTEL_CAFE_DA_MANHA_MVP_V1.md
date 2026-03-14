# Yes Hotel - Cafe da Manha MVP V1

## Objetivo da tela

Entregar uma tela operacional muito simples para a equipe do cafe visualizar, por apartamento, o status basico do atendimento do cafe da manha e ajustar rapidamente quantas pessoas ja vieram.

## Regra simples adotada

- cada card representa um apartamento
- o controle e agregado por apartamento, nao por pessoa
- `arrivedGuests` comeca no valor mockado e pode ser ajustado em `+1` ou `-1`
- `arrivedGuests` nao pode ficar abaixo de `0`
- `arrivedGuests` nao pode passar de `expectedGuests`
- `missingGuests` e calculado como `expectedGuests - arrivedGuests`
- quando `missingGuests` chega a `0`, o apartamento aparece como completo

## Campos exibidos

- apartamento
- hospede principal
- pago ou nao pago
- quantidade prevista
- quantidade que ja veio
- quantidade que falta

## Interacao permitida

- botao `-` para diminuir a quantidade atendida
- botao `+` para aumentar a quantidade atendida

## Limitacoes atuais

- usa dados mockados locais
- nao ha persistencia
- nao ha backend
- nao ha integracao com reservas reais
- nao ha filtro, busca, relatorio ou controle individual por hospede

## Proximos passos possiveis

1. conectar a uma fonte real de apartamentos/reservas
2. persistir a quantidade atendida
3. incluir atualizacao compartilhada para a equipe
4. so depois discutir filtros e refinamentos visuais
