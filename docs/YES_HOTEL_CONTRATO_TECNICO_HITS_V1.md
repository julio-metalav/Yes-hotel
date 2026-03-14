# YES HOTEL - Contrato Tecnico HITS V1

## 1. Objetivo do documento

Este documento consolida o contrato tecnico inicial da integracao HITS -> Yes Hotel com base apenas nos endpoints, headers, parametros e campos ja confirmados no Swagger do HITS.

O objetivo desta etapa e:

- registrar tecnicamente o que ja esta confirmado
- organizar o uso inicial da API HITS pelo sistema Yes Hotel
- alinhar a leitura tecnica da API com a arquitetura congelada do projeto
- separar fatos confirmados de pontos ainda dependentes de validacao real

Este documento nao cria codigo, nao altera banco, nao redefine arquitetura e nao inventa endpoints alem dos ja observados.

## 2. Escopo

Este documento cobre:

- autenticacao confirmada no HITS
- endpoint de sincronizacao de reservas
- endpoint de detalhe da reserva
- campos relevantes para o Yes Hotel
- estrategia tecnica inicial de sincronizacao
- estrategia inicial para detectar troca de apartamento
- impactos funcionais esperados no Yes
- endpoints observados, mas ainda nao aprofundados
- lacunas tecnicas ainda pendentes

Este documento nao cobre:

- implementacao da integracao
- definicao final de payload interno do Yes
- modelagem nova de banco
- criacao de migration
- confirmacao final de comportamento da API em ambiente autenticado

## 3. Arquitetura congelada e principios

Este contrato tecnico deve obedecer integralmente a arquitetura congelada do projeto:

- HITS controla hospedagem
- Yes controla credencial
- TTLock executa acesso

Principios obrigatorios para interpretar a API HITS:

- HITS e fonte oficial externa da hospedagem
- Yes consolida internamente o estado operacional
- reserva, apartamento, datas e mudancas de hospedagem devem vir do HITS
- credencial e senha operacional nao devem ser controladas pelo HITS
- o fluxo padrao nao deve depender de geracao manual no app da TTLock
- a integracao deve privilegiar rastreabilidade, idempotencia e reconciliacao

## 4. Fonte tecnica confirmada

Swagger JSON confirmado:

- `https://api.hitspms.net/swagger/v1/swagger.json`

Leitura tecnica provisoria:

- os endpoints confirmados ja sao suficientes para desenhar o contrato tecnico inicial de busca e detalhamento de reservas
- ainda e necessario teste autenticado para confirmar comportamento real de resposta, filtros e consistencia operacional

## 5. Autenticacao HITS confirmada

Endpoint confirmado:

- `POST /Authorize`

Observacoes confirmadas:

- usa header `X-API-VERSION`
- o body envolve credencial ou segredo compartilhado do parceiro
- a resposta devolve token de acesso
- existe conceito de tenant, property e partner user nos headers utilizados nas chamadas posteriores

Conclusao tecnica provisoria:

- existe indico forte de autenticacao centralizada com emissao de token
- os headers de contexto operacional parecem ser obrigatorios nas chamadas de negocio
- a confirmacao final de formato de token, expiracao, renovacao e falhas depende de teste autenticado

## 6. Endpoint de sincronizacao de reservas

Endpoint confirmado:

- `GET /Datashare/WebCheckinOut/Reservations`

Descricao confirmada:

- `Search reservations in the hotel`

### 6.1 Parametros confirmados

- `Type`
- `Status`
- `InitialDate`
- `FinalDate`
- `ReservationIntegrationId`
- `Page`
- `Size`

Valores confirmados para `Type`:

- `0` = Search for CheckIn Date
- `1` = Search for Reservation Inclusion Date
- `2` = Search for Reservation Update Date

Valores confirmados para `Status`:

- `1` = Confirmed
- `2` = Canceled
- `3` = Processed
- `4` = Blocked

### 6.2 Headers confirmados

- `X-API-VERSION`
- `X-API-TENANT-NAME`
- `X-API-PROPERTY-CODE`
- `X-API-PARTNER-USERID`
- `X-API-LANGUAGE-CODE`
- `X-Client-Id`

### 6.3 Campos confirmados no response

- `idReservation`
- `identity`
- `name`
- `mail`
- `phone`
- `zipCode`
- `address`
- `number`
- `neighborhood`
- `city`
- `country`
- `stateCode`
- `workingNationalDocument`
- `documentType`
- `checkIn`
- `checkOut`
- `dtBook`
- `status`
- `reservationIntegrationId`
- `reservationIntegratorId`
- `integrator`
- `reservationChannelId`

### 6.4 Conclusao tecnica provisoria

- este endpoint serve como base inicial para sincronizacao incremental
- `Type=2` combinado com intervalo de datas e indico forte para detectar reservas atualizadas
- `ReservationIntegrationId` aparenta ser util para busca mais direcionada ou reconciliacao
- a combinacao de filtros por data, status e pagina sugere caminho viavel para sincronizacao periodica segura

## 7. Endpoint de detalhe da reserva

Endpoint confirmado:

- `GET /Datashare/WebCheckinOut/Reservation/{id}`

Descricao confirmada:

- `Search a reservation in the hotel`

### 7.1 Headers confirmados

- `X-API-VERSION`
- `X-API-TENANT-NAME`
- `X-API-PROPERTY-CODE`
- `X-API-PARTNER-USERID`
- `X-API-LANGUAGE-CODE`
- `X-Client-Id`

### 7.2 Campos confirmados no topo da reserva

- `idReservation`
- `idEntityCompany`
- `companyName`
- `idRequesterCompany`
- `requesterCompanyName`
- `groupName`
- `contactName`
- `contact1`
- `contact2`
- `dateAdd`
- `dateUp`
- `notes[]`

### 7.3 Campos confirmados em `rooms[]`

- `idRoom`
- `code`
- `checkIn`
- `checkOut`
- `idRoomType`
- `roomTypeName`
- `amount`
- `status`
- `pax`
- `chd1`
- `chd2`
- `chd3`
- `ratePlanId`
- `ratePlanName`
- `mealPlanDesc`
- `requirementReservation[]`
- `reservationRoomId`

### 7.4 Campos confirmados em `guests[]`

- `idEntity`
- `name`
- `idRoom`
- `contactMail`
- `contactPhone`
- `main`
- `federalRegistrationNumber`
- `documentType`
- `notes[]`
- `gender`
- `birthDate`
- `mainDocType`
- `docCpfCnpjPassport`
- `addressZipCode`
- `addressCountry`
- `addressStateCode`
- `addressStateName`
- `addressCity`
- `addressNeighborhood`
- `addressAddress`
- `addressDetails`
- `addressNumber`

### 7.5 Outros campos confirmados

- `commissions[]`
- `revenueManagement`
- `creditState`
- `reservationTotalAmount`
- `reservationBalanceDue`
- `chargeTags[]`

### 7.6 Conclusao tecnica provisoria

- este endpoint serve para obter o quarto real, hospedes, datas e dados operacionais necessarios ao Yes
- ha indicio forte de que a alocacao do quarto e entregue por `rooms[].idRoom` e `rooms[].code`
- ha indicio forte de que o vinculo hospede -> quarto aparece por `guests[].idRoom`
- `dateUp` aparenta ser chave importante para detectar mudancas recentes, mas isso ainda depende de teste autenticado

## 8. Campos relevantes para o sistema Yes

Os campos abaixo sao os mais relevantes, no estado atual de confirmacao, para alimentar o nucleo operacional do Yes.

### 8.1 Identificacao e correlacao da reserva

- `idReservation`
- `reservationIntegrationId`
- `reservationIntegratorId`
- `integrator`
- `identity`

Uso tecnico esperado:

- correlacionar a reserva externa no HITS com a reserva consolidada no Yes
- permitir idempotencia de sincronizacao
- sustentar busca incremental e reconciliacao

### 8.2 Hospedagem e datas

- `checkIn`
- `checkOut`
- `dtBook`
- `dateAdd`
- `dateUp`
- `status`

Uso tecnico esperado:

- determinar periodo de hospedagem
- detectar inclusoes e alteracoes
- distinguir reservas ativas, canceladas ou potencialmente encerradas

### 8.3 Quarto e alocacao

- `rooms[].idRoom`
- `rooms[].code`
- `rooms[].checkIn`
- `rooms[].checkOut`
- `rooms[].status`
- `rooms[].reservationRoomId`

Uso tecnico esperado:

- identificar o apartamento operacional da reserva
- detectar troca de apartamento entre sincronizacoes
- definir impacto sobre credenciais e provisionamento fisico

### 8.4 Hospedes e contato

- `name`
- `mail`
- `phone`
- `guests[].name`
- `guests[].contactMail`
- `guests[].contactPhone`
- `guests[].main`
- `guests[].idRoom`
- `workingNationalDocument`
- `documentType`
- `guests[].federalRegistrationNumber`
- `guests[].mainDocType`
- `guests[].docCpfCnpjPassport`

Uso tecnico esperado:

- identificar hospede principal
- identificar disponibilidade de contato para FNRH e mensagens
- sustentar consolidacao de hospedes e documentos no Yes

### 8.5 Contexto adicional

- `notes[]`
- `contactName`
- `contact1`
- `contact2`
- `groupName`
- `companyName`
- `requesterCompanyName`
- `reservationChannelId`

Uso tecnico esperado:

- enriquecer leitura operacional da reserva
- registrar observacoes relevantes
- apoiar tratamento de excecoes e atendimento operacional

## 9. Estrategia tecnica inicial de sincronizacao HITS -> Yes

Estrategia inicial recomendada:

1. autenticar no HITS
2. executar busca de reservas no endpoint de listagem
3. usar filtros por data, status e pagina para sincronizacao controlada
4. para cada reserva relevante, buscar o detalhe completo
5. comparar o estado recebido com o estado consolidado no Yes
6. gerar eventos internos de reserva criada, alterada, cancelada ou reavaliada
7. disparar impactos operacionais em credencial, mensagens, FNRH e painel

Leitura tecnica provisoria:

- o endpoint de listagem deve funcionar como porta de entrada da sincronizacao
- o endpoint de detalhe deve funcionar como fonte principal para consolidacao operacional da reserva
- `Type=2` com `InitialDate` e `FinalDate` e o caminho mais forte, neste momento, para detectar reservas atualizadas
- `Page` e `Size` permitem construir um fluxo de sincronizacao rastreavel e paginado

Recomendacao inicial:

- nao depender de uma unica chamada de detalhe isolada
- usar listagem para identificar candidatos a sincronizacao
- usar detalhe para consolidar dados operacionais completos

## 10. Estrategia inicial para detectar troca de apartamento

Estrategia inicial provisoria:

- armazenar o quarto atual conhecido da reserva no Yes
- comparar esse valor com o quarto retornado em sincronizacao posterior
- tratar mudanca em `rooms[].idRoom` e ou `rooms[].code` como indicio forte de troca de apartamento

Regras tecnicas provisoria:

- `rooms[].idRoom` parece ser o identificador estrutural mais confiavel do quarto no HITS
- `rooms[].code` aparentemente representa o codigo operacional do quarto
- a confirmacao de que `rooms[].code` corresponde exatamente ao numero operacional do apartamento do Yes ainda depende de teste autenticado

Conclusao operacional provisoria:

- troca de apartamento provavelmente sera detectada comparando `rooms[].idRoom` e `rooms[].code` entre sincronizacoes
- essa leitura reforca a arquitetura congelada: HITS controla hospedagem, Yes controla credencial, TTLock executa acesso

## 11. Impactos funcionais no Yes

### 11.1 Credencial

- nova reserva apta pode gerar credencial conforme a politica do Yes
- mudanca de apartamento exige reavaliacao imediata da credencial
- cancelamento exige revogacao da credencial
- mudanca de datas exige reavaliacao de validade
- encerramento exige expiracao ou revogacao conforme politica operacional

### 11.2 Fechaduras e portoes

- o apartamento vindo do HITS determina a fechadura principal da hospedagem
- o bloco derivado do apartamento determina os portoes aplicaveis
- troca de apartamento pode exigir troca de fechadura principal
- mudanca de bloco pode exigir ajuste tambem dos acessos de portao

### 11.3 FNRH

- dados de contato e hospedes vindos do HITS alimentam a jornada de FNRH no Yes
- endpoints de hospede e identificacao vistos no Swagger podem ter relacao com esse fluxo, mas ainda dependem de confirmacao
- o papel exato da API HITS no processo equivalente a FNRH ainda esta em aberto

### 11.4 Mensagens

- email e telefone confirmados no HITS sustentam envio inicial de mensagens
- alteracao de datas deve impactar reagendamento
- ausencia de contato deve ser tratada como condicao operacional relevante

### 11.5 Painel operacional

- divergencias entre HITS e Yes podem gerar alerta
- exemplos:
- reserva sem quarto claro
- quarto alterado sem reflexo em credencial
- reserva cancelada com acesso ainda ativo
- falta de contato para reserva que exige comunicacao

## 12. Endpoints observados mas ainda nao aprofundados

Foram observados no Swagger, mas ainda sem analise tecnica profunda:

- `PUT /Datashare/Folios/{folioId}/{entityId}/UpdateIdentificationCard`
- `POST /Datashare/Folios/{reservationId}/CheckIn`
- `GET /Datashare/InternetControl/FoliosClosed`
- `GET /Datashare/InternetControl/RoomingList`
- `POST /Datashare/Reservation/{reservationId}/IncludePayment`
- `POST /Datashare/WebCheckinOut/Guests/{reservationId}`
- `PUT /Datashare/WebCheckinOut/Guests`
- `POST /Datashare/WebCheckinOut/IncludeGuest`

Leitura tecnica provisoria:

- `UpdateIdentificationCard` tem indico forte de relacao com processo documental
- `CheckIn` pode ser relevante para confirmar entrada real via API
- `FoliosClosed` e `RoomingList` podem ter utilidade de reconciliacao operacional
- endpoints de `Guests` podem ser relevantes para complementar o fluxo de cadastro, check-in digital ou FNRH
- nada disso deve ser assumido como parte obrigatoria do fluxo minimo antes de validacao real

## 13. Lacunas / duvidas pendentes

Pontos que ainda dependem de validacao:

- validar autenticacao real com credenciais do hotel
- confirmar significado exato dos enums numericos
- confirmar especialmente o significado de `rooms[].status`
- confirmar se `rooms[].code` corresponde exatamente ao numero operacional do apartamento
- confirmar fluxo de check-in e check-out real via API
- confirmar papel real do endpoint `UpdateIdentificationCard`
- confirmar se `RoomingList` e ou `FoliosClosed` serao necessarios para reconciliacao operacional
- confirmar comportamento real de paginacao e filtros em ambiente autenticado
- confirmar se `dateUp` reflete sempre alteracao operacional relevante de reserva

Forma recomendada de registrar essas lacunas:

- indico forte
- aparentemente
- a confirmar em teste autenticado

## 14. Proximos passos

Sequencia tecnica recomendada:

1. validar autenticacao real no endpoint `POST /Authorize`
2. executar chamadas reais no endpoint de listagem
3. executar chamadas reais no endpoint de detalhe
4. confirmar mapeamento `rooms[].code` -> apartamento operacional do Yes
5. confirmar estrategia de sincronizacao incremental com `Type=2`
6. confirmar semantica de status de reserva e status de quarto
7. definir contrato interno HITS -> Yes
8. so depois iniciar implementacao da integracao

## 15. Resumo executivo final

Conclusoes tecnicas provisoria:

- o HITS ja apresenta endpoints suficientes para iniciar o contrato tecnico minimo de sincronizacao
- `GET /Datashare/WebCheckinOut/Reservations` deve ser a base da sincronizacao incremental
- `GET /Datashare/WebCheckinOut/Reservation/{id}` deve ser a base da consolidacao operacional completa da reserva
- existe indico forte de que quarto e alocacao sao representados por `rooms[].idRoom` e `rooms[].code`
- existe indico forte de que o vinculo hospede -> quarto aparece em `guests[].idRoom`
- `dateUp` e `Type=2` apontam para um caminho viavel de deteccao de atualizacao
- a arquitetura congelada permanece reforcada:
- HITS controla hospedagem
- Yes controla credencial
- TTLock executa acesso

## 16. Decisao operacional provisoria sobre a TAG

Conclusao provisoria:

- a TAG nao deve ser desligada ainda
- primeiro e necessario validar autenticacao real, chamadas reais, mapeamento quarto <-> fechadura e fluxo minimo de FNRH e credencial
- so depois deve ser planejada a transicao operacional
