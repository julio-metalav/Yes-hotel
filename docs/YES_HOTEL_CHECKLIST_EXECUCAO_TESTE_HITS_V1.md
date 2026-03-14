# YES HOTEL - Checklist Execucao Teste HITS V1

## 1. Titulo

Checklist operacional para execucao manual dos testes autenticados da API HITS no contexto do projeto Yes Hotel.

## 2. Objetivo do checklist

Este documento deve ser usado como roteiro pratico durante a execucao manual dos testes autenticados da API HITS.

O objetivo e permitir registrar:

- o que foi tentado
- o que respondeu
- o que funcionou
- o que falhou
- quais evidencias foram coletadas
- quais conclusoes ja podem ser tiradas
- quais pontos ainda ficaram pendentes

Este checklist nao executa integracao, nao altera banco, nao cria migration, nao altera schema e nao implementa codigo.

## 3. Regras de seguranca durante o teste

- nao expor credenciais reais em commits
- nao salvar segredo em documento versionado
- mascarar dados sensiveis nos prints
- registrar apenas o minimo necessario
- nao executar acoes destrutivas sem confirmacao
- priorizar chamadas de leitura antes de qualquer endpoint de escrita
- nao compartilhar `<ACCESS_SECRET>` ou `<TOKEN>` em mensagens abertas
- nao salvar tokens validos em documentos persistentes sem necessidade
- revisar prints antes de arquivar para garantir mascaramento
- manter o teste restrito ao ambiente e aos dados estritamente necessarios

## 4. Dados reais que precisam ser obtidos antes do teste

Antes do teste, confirmar posse dos seguintes dados:

- `<ACCESS_SECRET>`
- `<TENANT_NAME>`
- `<PROPERTY_CODE>`
- `<PARTNER_USER_ID>`
- `<CLIENT_ID>`
- valor real de `X-API-VERSION`
- ao menos um `<RESERVATION_ID>` real para teste
- idealmente um caso de reserva com quarto conhecido operacionalmente

Checklist:

- [ ] confirmar posse de `<ACCESS_SECRET>`
- [ ] confirmar posse de `<TENANT_NAME>`
- [ ] confirmar posse de `<PROPERTY_CODE>`
- [ ] confirmar posse de `<PARTNER_USER_ID>`
- [ ] confirmar posse de `<CLIENT_ID>`, se exigido
- [ ] confirmar valor real de `X-API-VERSION`
- [ ] confirmar pelo menos um `<RESERVATION_ID>` real
- [ ] confirmar ao menos um quarto real conhecido na operacao do hotel
- [ ] confirmar ferramenta de teste manual disponivel

## 5. Checklist de autenticacao

Endpoint:

- `POST /Authorize`

Checklist operacional:

- [ ] confirmar posse de `<ACCESS_SECRET>`
- [ ] confirmar `X-API-VERSION` a usar
- [ ] montar requisicao `POST /Authorize`
- [ ] validar body real conforme orientacao recebida do HITS
- [ ] executar chamada
- [ ] registrar status HTTP retornado
- [ ] registrar tempo de resposta
- [ ] registrar se `AccessToken` ou token equivalente foi retornado
- [ ] registrar se houve erro `400`, `401` ou `403`
- [ ] salvar evidencia mascarada da resposta
- [ ] concluir se autenticacao foi validada ou nao

Quadro de registro manual:

| Campo | Registro |
|---|---|
| Data/hora do teste | |
| X-API-VERSION usada | |
| HTTP status | |
| Token retornado | |
| Erro encontrado | |
| Observacoes | |

## 6. Checklist de teste do endpoint de listagem de reservas

Endpoint:

- `GET /Datashare/WebCheckinOut/Reservations`

Headers esperados:

- `X-API-VERSION`
- `X-API-TENANT-NAME`
- `X-API-PROPERTY-CODE`
- `X-API-PARTNER-USERID`
- `X-API-LANGUAGE-CODE`
- `X-Client-Id`
- `<TOKEN>`, se exigido na autenticacao real

Checklist operacional:

- [ ] chamada autenticada executada com sucesso
- [ ] headers reais preenchidos corretamente
- [ ] teste com `Type=0`
- [ ] teste com `Type=1`
- [ ] teste com `Type=2`
- [ ] teste com `Status=1`
- [ ] teste com `Status=2`
- [ ] verificar se existem reservas reais no retorno
- [ ] verificar se `idReservation` veio no retorno
- [ ] verificar se `checkIn` e `checkOut` vieram no retorno
- [ ] verificar se `status` veio no retorno
- [ ] verificar se `mail` e `phone` vieram no retorno
- [ ] verificar se `dateUp` ou equivalente ficou acessivel para sincronizacao incremental
- [ ] salvar evidencia mascarada de ao menos uma resposta valida

Quadro de registro manual:

| Data/hora do teste | Filtros usados | HTTP status | Resultado resumido | Observacoes |
|---|---|---|---|---|
|  |  |  |  |  |
|  |  |  |  |  |
|  |  |  |  |  |

## 7. Checklist de teste do endpoint de detalhe da reserva

Endpoint:

- `GET /Datashare/WebCheckinOut/Reservation/{id}`

Checklist operacional:

- [ ] chamada autenticada executada com sucesso
- [ ] `<RESERVATION_ID>` consultado corresponde a uma reserva real
- [ ] `rooms[]` veio preenchido
- [ ] `rooms[].idRoom` veio preenchido
- [ ] `rooms[].code` veio preenchido
- [ ] `rooms[].checkIn` veio preenchido
- [ ] `rooms[].checkOut` veio preenchido
- [ ] `guests[]` veio preenchido
- [ ] `guests[].main` ficou identificavel
- [ ] `guests[].idRoom` ficou compativel com `rooms[].idRoom`
- [ ] `contactMail` e `contactPhone` vieram
- [ ] documentos do hospede vieram
- [ ] `dateAdd` e `dateUp` vieram
- [ ] salvar evidencia mascarada da resposta

Quadro de registro manual:

| Campo | Registro |
|---|---|
| Data/hora do teste | |
| Reservation consultada | |
| HTTP status | |
| Rooms preenchido | |
| Guests preenchido | |
| Rooms.code observado | |
| DateUp observado | |
| Observacoes | |

## 8. Checklist de validacoes operacionais do Yes

- [ ] `rooms[].code` corresponde ao numero operacional do apartamento no Yes?
- [ ] `rooms[].idRoom` pode ser usado como chave estavel de referencia no HITS?
- [ ] o detalhe da reserva contem informacao suficiente para gerar credencial?
- [ ] o detalhe contem informacao suficiente para FNRH e check-in digital?
- [ ] a combinacao `Type=2 + dateUp` e suficiente para sincronizacao incremental?
- [ ] uma troca de apartamento tende a ser detectavel comparando `rooms[].idRoom` e `rooms[].code`?
- [ ] o hospede principal esta claramente identificavel?
- [ ] os dados de contato sao suficientes para mensagens automaticas?

Registro resumido de validacao:

| Validacao | Resultado | Observacoes |
|---|---|---|
| Rooms.code bate com quarto operacional | | |
| Rooms.idRoom parece chave estavel | | |
| Dados suficientes para credencial | | |
| Dados suficientes para FNRH | | |
| Type=2 + dateUp viavel | | |
| Troca de apartamento detectavel | | |
| Hospede principal identificavel | | |
| Contato suficiente para mensagens | | |

## 9. Evidencias obrigatorias a salvar

Devem ser guardadas obrigatoriamente:

- print do sucesso da autenticacao
- print mascarado do token ou retorno equivalente
- print de resposta valida de listagem
- print de resposta valida de detalhe
- anotacao do quarto operacional conhecido comparado com `rooms[].code`
- registro de qualquer erro `400`, `401`, `403` ou `500` encontrado
- conclusoes objetivas apos cada teste

Checklist:

- [ ] print mascarado da autenticacao bem-sucedida
- [ ] print mascarado do retorno com token
- [ ] print mascarado de resposta valida da listagem
- [ ] print mascarado de resposta valida do detalhe
- [ ] anotacao de comparacao quarto operacional x `rooms[].code`
- [ ] registro de erros HTTP encontrados
- [ ] conclusao objetiva registrada ao final de cada teste

## 10. Criterios para considerar o teste aprovado

So considerar o teste aprovado quando todos os pontos abaixo forem atendidos:

- [ ] autenticacao funcionar
- [ ] listagem de reservas funcionar
- [ ] detalhe da reserva funcionar
- [ ] quarto real puder ser identificado
- [ ] vinculo hospede -> quarto ficar claro
- [ ] datas operacionais do quarto ficarem claras
- [ ] conclusao sobre viabilidade da sincronizacao incremental puder ser registrada

Conclusao final:

- [ ] teste aprovado
- [ ] teste parcialmente aprovado
- [ ] teste reprovado

## 11. Bloqueios que impedem seguir para integracao

Devem ser tratados como bloqueio:

- [ ] nao conseguir autenticar
- [ ] nao conseguir listar reservas reais
- [ ] nao conseguir obter detalhe da reserva
- [ ] `rooms[].code` nao bater com a operacao real do hotel
- [ ] ausencia de dado suficiente para credencial ou FNRH
- [ ] duvida relevante sobre atualizacao ou troca de quarto

Registro de bloqueios:

| Bloqueio encontrado | Impacto | Observacoes |
|---|---|---|
|  |  |  |
|  |  |  |
|  |  |  |

## 12. Conclusao operacional provisoria

Orientacao operacional provisoria:

- ainda nao desligar a TAG sem validacao real concluida
- primeiro provar autenticacao, leitura real, quarto operacional e dados minimos de credencial e FNRH
- a transicao so deve ser planejada apos evidencias concretas

## 13. Proximos passos apos o teste

Sequencia recomendada:

1. consolidar evidencias
2. atualizar o contrato tecnico HITS, se necessario
3. decidir se ja existe base suficiente para prova de conceito de sincronizacao
4. so depois discutir implementacao no sistema Yes
