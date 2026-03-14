# YES HOTEL - Plano de Teste Autenticado HITS V1

## 1. Objetivo

Este documento define o plano de validacao autenticada da API HITS antes de qualquer implementacao real no sistema Yes Hotel.

O objetivo desta etapa e:

- obter as credenciais e identificadores reais necessarios para autenticar
- validar manualmente o endpoint de autenticacao
- validar manualmente os endpoints de listagem e detalhe de reserva
- confirmar se os campos ja observados no Swagger se comportam como esperado em ambiente real
- coletar evidencias objetivas para decidir se a integracao pode seguir para a fase de implementacao
- reduzir risco operacional antes de qualquer transicao ou desligamento da TAG

Este documento nao executa integracao, nao altera banco, nao cria migration e nao implementa codigo de producao.

## 2. Pre-requisitos

Antes de iniciar os testes autenticados, e necessario ter:

- acesso de rede ao ambiente real da API HITS
- confirmacao do hotel ou fornecedor sobre as credenciais validas
- uma ferramenta de teste manual, como Postman, Insomnia ou cliente HTTP equivalente
- pelo menos uma reserva real de referencia para consulta detalhada
- pelo menos um periodo conhecido com reservas confirmadas, canceladas ou atualizadas
- alinhamento com a operacao do hotel para interpretar corretamente quarto, status e alteracoes

Condicoes de trabalho recomendadas:

- registrar data e hora de cada teste
- registrar o ambiente exato utilizado
- usar sempre placeholders controlados em documentos e anotacoes compartilhadas
- evitar espalhar credenciais em mensagens, prints ou arquivos soltos

## 3. Credenciais e identificadores necessarios

As informacoes reais ainda precisam ser obtidas do HITS, do hotel ou do parceiro responsavel:

- `<ACCESS_SECRET>`
- `<TENANT_NAME>`
- `<PROPERTY_CODE>`
- `<PARTNER_USER_ID>`
- `<CLIENT_ID>`
- valor real de `X-API-VERSION`

Tambem serao necessarios, para teste funcional:

- `<RESERVATION_ID>`
- ao menos um intervalo de datas real com reservas conhecidas
- pelo menos um caso real de reserva alterada recentemente, se possivel
- pelo menos um caso real de troca de apartamento, se existir historico conhecido

Pontos a confirmar no momento da coleta dessas credenciais:

- qual payload exato deve ser enviado em `POST /Authorize`
- se o token tem expiracao curta ou longa
- se existe obrigatoriedade adicional de header `Authorization` nas chamadas seguintes
- se todos os headers observados no Swagger sao obrigatorios em ambiente real

## 4. Teste de autenticacao

Endpoint a testar:

- `POST /Authorize`

### 4.1 Objetivo do teste

Validar que:

- a credencial real autentica com sucesso
- o token de acesso e retornado corretamente
- a API responde de forma consistente a credencial invalida ou incompleta

### 4.2 Dados necessarios

- `X-API-VERSION: <valor_real>`
- body real contendo `<ACCESS_SECRET>` ou credencial equivalente confirmada pelo HITS

### 4.3 Procedimento manual

1. Abrir a ferramenta de teste manual.
2. Configurar a requisicao `POST /Authorize`.
3. Informar `X-API-VERSION` com o valor real.
4. Montar o body exatamente conforme a documentacao real recebida do HITS.
5. Enviar a requisicao.
6. Registrar status HTTP, tempo de resposta e payload retornado.
7. Repetir um teste controlado com credencial invalida, se isso for permitido operacionalmente.

### 4.4 O que observar

- se a resposta devolve token de acesso
- se a resposta informa expiracao ou metadado equivalente
- se existe retorno adicional exigido para uso nas chamadas seguintes
- se falhas de autenticacao retornam erro claro e padronizado

### 4.5 Resultado esperado

- autenticacao bem-sucedida com token utilizavel
- entendimento minimo de como reutilizar esse token nas proximas chamadas

## 5. Teste de listagem de reservas

Endpoint a testar:

- `GET /Datashare/WebCheckinOut/Reservations`

### 5.1 Objetivo do teste

Validar que:

- a autenticacao realmente habilita acesso ao endpoint
- os headers operacionais aceitos no Swagger funcionam em ambiente real
- os filtros por data, tipo e status retornam reservas coerentes
- `Type=2` tem potencial real para sincronizacao incremental

### 5.2 Headers a informar

- `X-API-VERSION: <valor_real>`
- `X-API-TENANT-NAME: <TENANT_NAME>`
- `X-API-PROPERTY-CODE: <PROPERTY_CODE>`
- `X-API-PARTNER-USERID: <PARTNER_USER_ID>`
- `X-API-LANGUAGE-CODE: <valor_real>`
- `X-Client-Id: <CLIENT_ID>`
- token de acesso conforme autenticacao real, se exigido

### 5.3 Parametros prioritarios para teste

- `Type=0`
- `Type=1`
- `Type=2`
- `Status=1`
- `Status=2`
- `InitialDate=<data_inicial_real>`
- `FinalDate=<data_final_real>`
- `Page=1`
- `Size=<tamanho_controlado>`

### 5.4 Procedimento manual

1. Executar a chamada com `Type=0` para um intervalo conhecido de check-in.
2. Executar a chamada com `Type=1` para testar inclusao de reservas.
3. Executar a chamada com `Type=2` para testar atualizacoes.
4. Repetir com `Status=1` e `Status=2`.
5. Testar paginação com pelo menos dois tamanhos de pagina, se houver volume suficiente.
6. Registrar amostras de reservas retornadas.

### 5.5 O que observar

- se a chamada retorna dados sem erro com os headers informados
- se os filtros por data mudam o conjunto retornado de forma coerente
- se `Type=2` retorna reservas alteradas recentemente
- se `Status=2` realmente traz canceladas
- se a paginação funciona sem duplicar ou omitir registros
- se `reservationIntegrationId` pode ser usado para rastrear a mesma reserva com consistencia

## 6. Teste de detalhe da reserva

Endpoint a testar:

- `GET /Datashare/WebCheckinOut/Reservation/{id}`

### 6.1 Objetivo do teste

Validar que:

- o detalhe da reserva entrega dados suficientes para consolidacao operacional no Yes
- quarto, hospedes, datas e contatos aparecem de forma coerente
- `rooms[].idRoom`, `rooms[].code`, `guests[].idRoom` e `dateUp` fazem sentido em ambiente real

### 6.2 Dados necessarios

- `<RESERVATION_ID>` real, obtido preferencialmente da listagem
- mesmos headers autenticados usados na listagem

### 6.3 Procedimento manual

1. Selecionar pelo menos uma reserva retornada na listagem.
2. Executar o detalhe usando `<RESERVATION_ID>`.
3. Registrar o payload completo de resposta.
4. Repetir com pelo menos:
- uma reserva confirmada
- uma reserva com hospedes multiplos, se existir
- uma reserva alterada recentemente, se possivel

### 6.4 O que observar

- se `rooms[]` vem preenchido de forma consistente
- se `rooms[].code` parece corresponder ao quarto operacional real
- se `guests[].idRoom` aponta para o mesmo quarto de `rooms[].idRoom`
- se `dateUp` muda quando a reserva sofre alteracao relevante
- se `notes[]`, `contact1`, `contact2` e dados de hospede ajudam operacionalmente
- se ha campos nulos inesperados em reservas reais que deveriam estar completas

## 7. Validacoes operacionais a observar

### 7.1 Validar se `rooms[].code` corresponde ao quarto operacional real

Forma de validar:

- comparar o `rooms[].code` retornado pela API com o numero operacional conhecido pelo hotel
- validar com reservas reais em apartamentos conhecidos
- confirmar com a operacao se o codigo retornado representa exatamente o apartamento exibido no HITS

Resultado esperado:

- correspondencia direta e consistente entre `rooms[].code` e o numero operacional do apartamento

Status a registrar:

- confirmado
- aparentemente confirmado
- divergente
- a confirmar em teste real

### 7.2 Validar se `dateUp + Type=2` servem para sincronizacao incremental

Forma de validar:

- selecionar uma reserva conhecida
- provocar ou identificar uma alteracao real no HITS
- repetir a listagem com `Type=2` em janela curta
- verificar se a reserva reaparece no conjunto retornado
- comparar o valor de `dateUp` antes e depois da alteracao

Resultado esperado:

- a reserva alterada reaparece de forma consistente
- `dateUp` reflete a alteracao operacional relevante

### 7.3 Validar se troca de apartamento podera ser detectada

Forma de validar:

- obter uma reserva que tenha sofrido troca de apartamento, se houver caso real
- comparar `rooms[].idRoom` e `rooms[].code` antes e depois
- verificar se o detalhe da reserva mostra o novo quarto de forma inequívoca
- validar com a operacao do hotel qual foi o apartamento anterior e o novo

Resultado esperado:

- a troca fica visivel no payload
- o quarto novo pode ser identificado com seguranca operacional

### 7.4 Validar dados de contato e hospede principal

Forma de validar:

- verificar se `mail`, `phone`, `guests[].contactMail`, `guests[].contactPhone` e `guests[].main` aparecem de forma coerente
- validar se existe informacao suficiente para o fluxo de FNRH e mensagens

Resultado esperado:

- pelo menos uma forma confiavel de identificar contato operacional utilizavel

## 8. Evidencias que devem ser salvas

As evidencias minimas a serem guardadas sao:

- print ou export controlado do teste de autenticacao bem-sucedido
- print ou export controlado do erro de autenticacao, se testado
- print ou export de chamadas de listagem com `Type=0`, `Type=1` e `Type=2`
- print ou export de chamadas de detalhe de pelo menos uma reserva real
- registro dos headers efetivamente aceitos
- anotacao sobre comportamento de paginacao
- anotacao sobre significado observado de status
- evidencias de correspondencia entre `rooms[].code` e quarto operacional
- evidencias de mudanca ou nao mudanca de `dateUp`
- evidencias de troca de apartamento, se houver caso real

Boas praticas para salvar evidencias:

- mascarar segredos e tokens
- nao expor dados sensiveis em arquivos compartilhados sem controle
- registrar data e hora de coleta
- registrar qual reserva foi usada, com identificador controlado

## 9. Criterios minimos de sucesso

Antes de partir para codigo, os resultados minimos esperados sao:

- autenticacao real funcionando
- confirmacao dos headers realmente obrigatorios
- listagem de reservas funcionando com filtros basicos
- detalhe de reserva funcionando com payload coerente
- confirmacao operacional de que `rooms[].code` mapeia corretamente o quarto
- confirmacao de que `Type=2` e `dateUp` servem, ao menos em nivel inicial, para detectar atualizacao
- confirmacao de que troca de apartamento pode ser identificada por dados retornados
- confirmacao de que ha dados suficientes para iniciar desenho tecnico do fluxo de FNRH e comunicacao

## 10. Bloqueios que impedem desligar a TAG

A TAG nao deve ser desligada enquanto qualquer um dos pontos abaixo permanecer em aberto:

- autenticacao real nao validada
- headers reais ainda nao confirmados
- mapeamento quarto HITS -> apartamento operacional nao confirmado
- troca de apartamento ainda nao rastreavel com seguranca
- estrategia incremental com `Type=2` ainda nao validada
- fluxo minimo de FNRH ainda nao compreendido
- impacto real sobre credencial e reprogramacao ainda nao validado
- ausencia de evidencias suficientes para reconciliacao operacional

Conclusao operacional provisoria:

- sem esses testes reais, nao ha base segura para transicao operacional
- portanto, a TAG nao deve ser desligada antes da validacao autenticada completa

## 11. Proximos passos

Sequencia recomendada apos este plano:

1. Obter credenciais e identificadores reais do HITS.
2. Executar o teste manual de autenticacao.
3. Executar o teste manual de listagem de reservas.
4. Executar o teste manual de detalhe da reserva.
5. Consolidar evidencias e registrar conclusoes.
6. Confirmar quarto operacional, atualizacao incremental e troca de apartamento.
7. Revisar riscos operacionais remanescentes.
8. So depois decidir pelo desenho tecnico de implementacao.
