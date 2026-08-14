# Yes Hotel - Cafe da Manha MVP V1

## Objetivo da tela

Entregar uma tela operacional muito simples para a equipe do cafe visualizar, por apartamento, o status basico do atendimento do cafe da manha e ajustar rapidamente quantas pessoas ja vieram.

## Regra operacional adotada

- cada card representa um apartamento
- o controle e agregado por apartamento, nao por pessoa
- a quantidade atendida pode ser ajustada em `+1` ou `-1`
- a quantidade atendida nao pode ficar abaixo de `0`
- a quantidade atendida nao pode passar de `entitledQty`
- faltantes e calculado como `entitledQty - attendedQty`
- `sem_cafe` e `nao_mapeado` tem direito zero e nao aceitam atendimento
- PPD e um estado adicional; nao altera o direito ao cafe

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
- botao para marcar todos os direitos elegiveis como atendidos

## Modo demonstracao

- URL: `cafe-da-manha-mvp.html?demo=1`
- exige a mesma autenticacao e autorizacao da tela normal
- o arquivo de fixtures so e carregado depois da autorizacao
- cobre `incluido`, `sem_cafe`, `avulso_pago` e `nao_mapeado`
- PPD pendente, vencido ou suspenso usa a mesma apresentacao: `DIÁRIA PENDENTE`
- quando houver valor confiavel: `DIÁRIA PENDENTE: R$ X,XX`
- PPD regularizado/pago nao exibe alerta na tela do cafe
- controles funcionam somente em memoria e nao chamam RPC, tabelas operacionais ou integracoes
- sem `?demo=1`, a carga e a gravacao reais permanecem inalteradas

## Limitacoes atuais

- o contrato oficial HITS para cafe ainda nao foi homologado
- o mapper real e a funcao SQL retornam `nao_mapeado` e direito zero por seguranca
- `meal_plan_desc` nao e interpretado como regra de negocio
- nao ha controle individual por hospede; o atendimento e agregado por reserva/apartamento

## Proximos passos possiveis

1. homologar o contrato oficial de cafe com o HITS
2. conectar os campos homologados ao resolvedor de entitlement existente
3. manter os quatro estados de dominio e os mesmos componentes operacionais
