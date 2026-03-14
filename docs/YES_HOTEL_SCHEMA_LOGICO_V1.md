# YES HOTEL - Schema Logico V1

## 1. Objetivo do documento

Este documento converte a arquitetura congelada e o modelo conceitual de dados do Yes Hotel em uma estrutura logica de dados.

O objetivo desta etapa e:

- transformar entidades conceituais em entidades logicas implementaveis
- definir relacoes logicas, chaves principais e chaves estrangeiras
- listar atributos principais por entidade
- registrar estados logicos minimos e regras de integridade conceitual
- preparar a derivacao posterior do schema fisico

Este documento ainda nao define SQL, migration, tipos exatos de coluna, indices finais, triggers, RLS ou endpoints.

## 2. Bases de referencia

Este documento deriva obrigatoriamente de:

- `D:\Automação_Yes_Hotel\docs\YES_HOTEL_FONTE_DA_VERDADE_ARQUITETURA.md`
- `D:\Automação_Yes_Hotel\docs\YES_HOTEL_MODELO_CONCEITUAL_DADOS.md`

Ambos os documentos estao congelados e devem prevalecer sobre qualquer interpretacao paralela.

## 3. Principios do schema logico

Os principios deste schema logico sao:

- reserva no centro da estrutura logica
- simplicidade operacional acima de sofisticacao desnecessaria
- separacao entre entidade de estado principal e entidade de evento historico
- separacao entre credencial logica, senha operacional, provisionamento fisico e evento real de acesso
- modelagem implementavel em Supabase/PostgreSQL depois, sem fisica prematura
- aderencia estrita ao contexto exclusivo do Yes Hotel
- apoio a reprocessamento, idempotencia e auditoria operacional minima

## 4. Convencoes de naming adotadas

As convencoes adotadas neste documento sao:

- nomes em portugues
- `snake_case`
- plural para entidades e tabelas logicas
- PK logica padrao como `id`
- FKs no padrao `<entidade_singular>_id`
- atributos de estado com nomes explicitos, como `status_reserva`, `status_credencial` e `status_alerta`
- sem misturar naming, enums ou convencoes de outros projetos

Observacoes importantes:

- o nome logico `acessos_senhas` sera mantido por continuidade com a arquitetura congelada
- apesar do naming, `acessos_senhas` representa a credencial principal da reserva
- se necessario, o naming podera ser refinado em etapa futura sem alterar o conceito ja congelado

## 5. Visao geral dos grupos de entidades

Os grupos logicos do schema sao:

- estrutura
- operacao
- check-in digital e contatos
- acesso
- comunicacao
- automacao
- alertas
- veiculos
- cafe
- usuarios internos

## 6. Entidades logicas por grupo

### 6.1 Cadastros estruturais

#### `blocos`

Finalidade logica:

- representar os blocos fisicos do hotel
- servir como referencia estrutural para apartamentos e portoes

PK logica:

- `id`

FKs logicas:

- nenhuma obrigatoria

Atributos principais esperados:

- `id`
- `nome`
- `codigo_portao_referencia`
- `ativo`

Estados minimos:

- `ativo`
- `inativo`

Observacoes de integridade conceitual:

- no contexto atual do Yes Hotel, cada bloco possui um portao principal
- `codigo_portao_referencia` e apenas referencia operacional do contexto atual, nao substitui a entidade `portoes`

#### `portoes`

Finalidade logica:

- representar os portoes principais dos blocos

PK logica:

- `id`

FKs logicas:

- `bloco_id`

Atributos principais esperados:

- `id`
- `bloco_id`
- `identificador_operacional`
- `ativo`

Estados minimos:

- `ativo`
- `inativo`

Observacoes de integridade conceitual:

- cada portao pertence a um bloco
- no contexto atual, o portao principal do bloco deve ser identificavel logicamente

#### `apartamentos`

Finalidade logica:

- representar as unidades de hospedagem

PK logica:

- `id`

FKs logicas:

- `bloco_id`

Atributos principais esperados:

- `id`
- `bloco_id`
- `numero`
- `identificador_operacional`
- `ativo`

Estados minimos:

- `ativo`
- `inativo`

Observacoes de integridade conceitual:

- apartamento pertence a um bloco
- `numero` deve ser unico no contexto logico adequado do hotel

#### `fechaduras`

Finalidade logica:

- representar os dispositivos fisicos usados para acesso

PK logica:

- `id`

FKs logicas:

- `apartamento_id` opcional
- `portao_id` opcional

Atributos principais esperados:

- `id`
- `tipo_fechadura`
- `apartamento_id`
- `portao_id`
- `identificador_externo_ttlock`
- `ativo`

Estados minimos:

- `ativo`
- `inativo`

Valores logicos minimos para `tipo_fechadura`:

- `apartamento`
- `portao_externo`
- `portao_interno`

Observacoes de integridade conceitual:

- uma fechadura deve estar vinculada a apartamento ou portao de acordo com seu tipo
- fechaduras de `apartamento` nao devem apontar para `portao`
- fechaduras de `portao_externo` e `portao_interno` nao devem apontar para `apartamento`
- este schema logico nao detalha payloads tecnicos da TTLock

### 6.2 Operacao principal

#### `reservas`

Finalidade logica:

- representar a hospedagem operacional central do sistema

PK logica:

- `id`

FKs logicas:

- `apartamento_id`
- `bloco_id`

Atributos principais esperados:

- `id`
- `identificador_reserva_externa`
- `origem_reserva`
- `apartamento_id`
- `bloco_id`
- `data_checkin_prevista`
- `data_checkout_prevista`
- `status_reserva`
- `status_operacional_reserva`
- `contato_email_principal`
- `contato_whatsapp_principal`
- `observacoes_operacionais`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Observacoes de integridade conceitual:

- `reservas` e o pivô do schema logico
- neste V1, `bloco_id` fica armazenado logicamente em `reservas` como redundancia controlada para favorecer operacao, acesso e consulta
- `bloco_id` em `reservas` nao e origem independente de classificacao estrutural; ele deriva do `apartamento_id` e deve permanecer coerente com ele
- a combinacao `origem_reserva` + `identificador_reserva_externa` deve ser tratada como referencia logica unica quando houver identificador externo

#### `hospedes`

Finalidade logica:

- representar as pessoas vinculadas a hospedagens

PK logica:

- `id`

FKs logicas:

- nenhuma obrigatoria

Atributos principais esperados:

- `id`
- `nome`
- `email`
- `telefone`
- `documento`
- `nacionalidade`
- `data_nascimento`

Estados minimos:

- nao aplicavel como estado principal nesta fase

Observacoes de integridade conceitual:

- hospede nao substitui a reserva como entidade central
- atributos adicionais de check-in podem ser detalhados no schema fisico, sem inflar este documento

#### `reserva_hospedes`

Finalidade logica:

- representar o vinculo entre reserva e hospedes

PK logica:

- `id`

FKs logicas:

- `reserva_id`
- `hospede_id`

Atributos principais esperados:

- `id`
- `reserva_id`
- `hospede_id`
- `papel_na_reserva`
- `ordem_na_reserva`

Estados minimos:

- nao aplicavel como estado principal nesta fase

Valores logicos minimos para `papel_na_reserva`:

- `principal`
- `acompanhante`

Observacoes de integridade conceitual:

- uma reserva pode possuir um ou mais hospedes
- o mesmo hospede pode aparecer em reservas diferentes
- nao ha necessidade de `quantidade_representada` neste V1

#### `checkins_digitais`

Finalidade logica:

- representar o processo principal de pre check-in e FNRH por hospedagem

PK logica:

- `id`

FKs logicas:

- `reserva_id`

Atributos principais esperados:

- `id`
- `reserva_id`
- `referencia_link_checkin`
- `status_checkin_digital`
- `enviado_em`
- `preenchido_em`
- `pendente_apos_chegada`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Observacoes de integridade conceitual:

- neste V1, ha um processo principal de check-in digital por hospedagem
- isso nao impede historico futuro mais refinado em etapa posterior
- `status_checkin_digital` e o elemento canonico de estado do processo
- `pendente_apos_chegada` deve ser tratado como atributo logico auxiliar ou derivavel, sem competir com o status principal

#### `pagamentos_operacionais`

Finalidade logica:

- representar o estado operacional principal de pagamento da hospedagem

PK logica:

- `id`

FKs logicas:

- `reserva_id`

Atributos principais esperados:

- `id`
- `reserva_id`
- `status_pagamento_operacional`
- `origem_status`
- `atualizado_em`
- `observacao`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Observacoes de integridade conceitual:

- neste V1, ha um registro principal de pagamento operacional por hospedagem
- isso nao transforma o sistema em modulo financeiro
- isso nao impede historico futuro mais refinado em etapa posterior

### 6.3 Acesso e credenciais

#### `acessos_senhas`

Finalidade logica:

- representar a credencial principal da reserva

PK logica:

- `id`

FKs logicas:

- `reserva_id`

Atributos principais esperados:

- `id`
- `reserva_id`
- `status_credencial`
- `senha_operacional`
- `validade_inicio`
- `validade_fim`
- `gerada_em`
- `enviada_ao_hospede_em`
- `motivo_revogacao`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Observacoes de integridade conceitual:

- `acessos_senhas` representa logicamente a credencial principal da reserva
- `senha_operacional` e um atributo logico da credencial, nao uma entidade separada
- `senha_operacional` e atributo operacional sensivel e pode exigir tratamento especifico no schema fisico e na aplicacao
- uma reserva possui no maximo uma credencial principal ativa por hospedagem
- a entidade deve suportar expiracao, revogacao e reprogramacao

#### `acessos_provisionamentos`

Finalidade logica:

- representar os provisionamentos fisicos da credencial nas fechaduras de destino

PK logica:

- `id`

FKs logicas:

- `acesso_senha_id`
- `fechadura_id`

Atributos principais esperados:

- `id`
- `acesso_senha_id`
- `fechadura_id`
- `status_provisionamento`
- `provisionado_em`
- `ultima_tentativa_em`
- `erro_ultima_tentativa`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Observacoes de integridade conceitual:

- uma credencial pode gerar multiplos provisionamentos
- cada provisionamento representa um destino fisico especifico
- deve existir no maximo um provisionamento logico por credencial e fechadura no contexto operacional corrente, salvo regra clara de reprocessamento controlado

#### `acessos_eventos`

Finalidade logica:

- representar eventos reais de uso das fechaduras

PK logica:

- `id`

FKs logicas:

- `reserva_id` opcional
- `fechadura_id`
- `acesso_senha_id` opcional

Atributos principais esperados:

- `id`
- `reserva_id`
- `fechadura_id`
- `acesso_senha_id`
- `tipo_evento_acesso`
- `ocorreu_em`
- `evento_primeiro_acesso`
- `origem_evento`
- `payload_referencia`

Estados minimos:

- nao aplicavel como estado principal, por ser entidade de evento historico

Valores logicos minimos para `tipo_evento_acesso`:

- `entrada_validada`
- `tentativa_negada`
- `revogacao_detectada`
- `evento_nao_classificado`

Observacoes de integridade conceitual:

- `reserva_id` pode ser nulo quando ainda nao houver vinculacao segura
- `acesso_senha_id` pode ser nulo quando ainda nao houver correlacao logica confiavel
- `evento_primeiro_acesso` deve ser entendido como marcador definido pela correlacao operacional do sistema, nao como informacao necessariamente fornecida pronta pela integracao externa
- deve ser possivel diferenciar evento de apartamento e de portao sempre que tecnicamente possivel
- a chegada real deve privilegiar o evento valido da fechadura do apartamento

### 6.4 Comunicacao e automacao

#### `mensagens`

Finalidade logica:

- representar o historico operacional de comunicacoes

PK logica:

- `id`

FKs logicas:

- `reserva_id`

Atributos principais esperados:

- `id`
- `reserva_id`
- `tipo_mensagem`
- `canal_mensagem`
- `destinatario`
- `status_mensagem`
- `conteudo_referencia`
- `enviada_em`
- `retorno_provedor`
- `tentativas`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Valores logicos minimos para `canal_mensagem`:

- `email`
- `whatsapp`

Observacoes de integridade conceitual:

- `mensagens` e historico operacional
- nao substitui templates nem configuracoes futuras de integracao
- `status_mensagem` neste V1 deve permanecer simples e aderente ao nivel de rastreabilidade operacional ja documentado

#### `jobs_automacao`

Finalidade logica:

- representar agendamentos, execucoes, retries e reprocessamentos

PK logica:

- `id`

FKs logicas:

- `reserva_id` opcional

Atributos principais esperados:

- `id`
- `reserva_id`
- `tipo_job`
- `status_job`
- `agendado_para`
- `executado_em`
- `tentativas`
- `erro_ultima_execucao`
- `referencia_entidade`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Observacoes de integridade conceitual:

- deve suportar agendamento, execucao, retry e reprocessamento
- `referencia_entidade` pode apontar logicamente para o objeto central do job sem exigir modelagem polimorfica detalhada nesta fase
- `referencia_entidade` podera ser refinada no schema fisico caso o desenho final exija maior padronizacao de correlacao

### 6.5 Alertas operacionais

#### `alertas_operacionais`

Finalidade logica:

- representar excecoes operacionais rastreaveis

PK logica:

- `id`

FKs logicas:

- `reserva_id` opcional
- `resolvido_por_usuario_interno_id` opcional

Atributos principais esperados:

- `id`
- `reserva_id`
- `tipo_alerta`
- `severidade`
- `status_alerta`
- `descricao_resumida`
- `aberto_em`
- `resolvido_em`
- `resolvido_por_usuario_interno_id`

Estados minimos:

- ver secao `8. Estados lógicos mínimos`

Valores logicos minimos para `severidade`:

- `baixa`
- `media`
- `alta`
- `critica`

Observacoes de integridade conceitual:

- alerta operacional e entidade de excecao, nao log generico
- alerta deve ser rastreavel do ponto de vista operacional

### 6.6 Veiculos e LPR

#### `placas_autorizadas`

Finalidade logica:

- representar autorizacoes operacionais de placa vinculadas a reserva

PK logica:

- `id`

FKs logicas:

- `reserva_id`
- `hospede_id` opcional
- `criada_por_usuario_interno_id` opcional

Atributos principais esperados:

- `id`
- `reserva_id`
- `hospede_id`
- `placa`
- `origem_cadastro`
- `ativa`
- `autorizada_inicio`
- `autorizada_fim`
- `criada_por_usuario_interno_id`

Estados minimos:

- `ativa`
- `inativa`

Valores logicos minimos para `origem_cadastro`:

- `fnrh`
- `manual`

Observacoes de integridade conceitual:

- a placa autorizada deve respeitar a janela operacional da reserva quando aplicavel
- o mesmo contexto operacional pode demandar mais de uma placa por reserva, sem quebrar o V1

#### `eventos_lpr`

Finalidade logica:

- representar leituras e validacoes operacionais vindas do LPR

PK logica:

- `id`

FKs logicas:

- `reserva_id` opcional
- `placa_autorizada_id` opcional

Atributos principais esperados:

- `id`
- `placa_lida`
- `reserva_id`
- `placa_autorizada_id`
- `ocorreu_em`
- `resultado_validacao`
- `acao_executada`
- `origem_equipamento`

Estados minimos:

- nao aplicavel como estado principal, por ser entidade de evento historico

Valores logicos minimos para `resultado_validacao`:

- `autorizada`
- `rejeitada`
- `nao_encontrada`
- `pendente_correlacao`

Observacoes de integridade conceitual:

- o evento pode ou nao ser vinculado a uma reserva no momento da chegada
- o vinculo a reserva depende de correspondencia operacional valida
- eventos podem ser correlacionados posteriormente sem alterar seu caracter historico

### 6.7 Cafe da manha

#### `cafe_presencas`

Finalidade logica:

- representar o controle operacional simples do cafe da manha por dia

PK logica:

- `id`

FKs logicas:

- `reserva_id`
- `apartamento_id`
- `registrado_por_usuario_interno_id` opcional

Atributos principais esperados:

- `id`
- `reserva_id`
- `data_operacao`
- `apartamento_id`
- `quantidade_esperada`
- `quantidade_presente`
- `status_operacional_cafe`
- `registrado_por_usuario_interno_id`

Estados minimos:

- nao obrigatorio como enum fechado nesta fase

Valores logicos possiveis para `status_operacional_cafe`, se usado:

- `nao_iniciado`
- `parcial`
- `concluido`

Observacoes de integridade conceitual:

- o modelo inicial e simples
- nao ha individualizacao obrigatoria por hospede neste V1
- `apartamento_id` reforca a leitura operacional da lista do dia e deve permanecer coerente com a reserva vinculada, nao funcionando como duplicacao estrutural independente

### 6.8 Usuarios internos

#### `usuarios_internos`

Finalidade logica:

- representar usuarios humanos com atuacao operacional no sistema

PK logica:

- `id`

FKs logicas:

- nenhuma obrigatoria

Atributos principais esperados:

- `id`
- `nome`
- `email_login`
- `perfil_usuario`
- `ativo`

Estados minimos:

- `ativo`
- `inativo`

Valores logicos minimos para `perfil_usuario`:

- `operacional`
- `administrativo`

Observacoes de integridade conceitual:

- `usuarios_internos` sustentam rastreabilidade, autoria, resolucao e override controlado
- este V1 nao detalha ainda perfis finos de permissao

## 7. Relacionamentos logicos principais

Os relacionamentos logicos principais sao:

- `blocos` 1:N `apartamentos`
- `blocos` 1:1 `portoes` no contexto atual do Yes Hotel
- `portoes` 1:N `fechaduras`
- `apartamentos` 1:N `reservas`
- `apartamentos` 1:N `fechaduras` no historico logico, embora operacionalmente exista uma principal por contexto atual
- `reservas` 1:N `reserva_hospedes`
- `hospedes` 1:N `reserva_hospedes`
- `reservas` 1:1 `checkins_digitais` como processo principal por hospedagem
- `reservas` 1:1 `pagamentos_operacionais` como registro principal por hospedagem
- `reservas` 1:1 `acessos_senhas` como credencial principal ativa por hospedagem
- `acessos_senhas` 1:N `acessos_provisionamentos`
- `fechaduras` 1:N `acessos_provisionamentos`
- `reservas` 1:N `acessos_eventos`
- `fechaduras` 1:N `acessos_eventos`
- `acessos_senhas` 1:N `acessos_eventos` quando houver correlacao confiavel
- `reservas` 1:N `mensagens`
- `reservas` 1:N `jobs_automacao`
- `reservas` 1:N `alertas_operacionais`
- `reservas` 1:N `placas_autorizadas`
- `placas_autorizadas` 1:N `eventos_lpr`
- `reservas` 1:N `eventos_lpr` quando houver vinculacao valida
- `reservas` 1:N `cafe_presencas`
- `usuarios_internos` 1:N `alertas_operacionais` resolvidos
- `usuarios_internos` 1:N `placas_autorizadas` criadas manualmente
- `usuarios_internos` 1:N `cafe_presencas` registradas

## 8. Estados logicos minimos

Os estados logicos minimos sugeridos para V1 sao:

### `reservas.status_reserva`

- `recebida`
- `confirmada`
- `cancelada`
- `em_hospedagem`
- `encerrada`

### `reservas.status_operacional_reserva`

- `aguardando_fnrh`
- `apta_para_credencial`
- `credencial_gerada`
- `chegada_detectada`
- `com_alerta`
- `concluida`

### `checkins_digitais.status_checkin_digital`

- `nao_iniciado`
- `enviado`
- `preenchido`
- `pendente_apos_chegada`

### `pagamentos_operacionais.status_pagamento_operacional`

- `pendente`
- `confirmado`
- `dispensado`
- `indefinido`

### `acessos_senhas.status_credencial`

- `pendente`
- `gerada`
- `provisionando`
- `ativa`
- `expirada`
- `revogada`
- `erro`

### `acessos_provisionamentos.status_provisionamento`

- `pendente`
- `provisionado`
- `erro`
- `revogado`

### `mensagens.status_mensagem`

- `pendente`
- `enviada`
- `entregue`
- `erro`

### `jobs_automacao.status_job`

- `pendente`
- `executando`
- `concluido`
- `erro`
- `cancelado`

### `alertas_operacionais.status_alerta`

- `aberto`
- `em_tratamento`
- `resolvido`
- `cancelado`

## 9. Regras de unicidade e integridade conceitual

As principais regras de unicidade e integridade conceitual deste V1 sao:

- `apartamentos.numero` deve ser unico no contexto logico do hotel
- cada bloco do Yes Hotel possui um portao principal no contexto atual
- `portoes.bloco_id` deve ser unico no contexto atual do V1
- `reservas` deve referenciar um `apartamento` valido
- `reservas.bloco_id` deve permanecer coerente com o bloco do apartamento referenciado
- a combinacao `origem_reserva` + `identificador_reserva_externa` nao deve se duplicar quando houver identificador externo disponivel
- uma reserva possui no maximo uma credencial principal ativa por hospedagem
- `acessos_provisionamentos` deve sempre referenciar exatamente uma credencial e uma fechadura
- a mesma credencial nao deve gerar provisionamentos duplicados concorrentes para a mesma fechadura sem regra clara de reprocessamento
- `checkins_digitais` principal e um por hospedagem
- `pagamentos_operacionais` principal e um por hospedagem
- evento historico nao substitui entidade de estado principal
- alerta operacional deve ser rastreavel
- placa autorizada deve respeitar janela operacional da reserva quando aplicavel

## 10. Regras especiais de acesso e credencial

As regras especiais de acesso e credencial neste schema logico sao:

- a credencial principal da reserva e unica por hospedagem
- `senha_operacional` e atributo logico da credencial
- provisionamentos fisicos sao separados da credencial principal
- eventos de acesso sao separados da credencial e dos provisionamentos
- o primeiro acesso deve ser identificavel no conjunto de `acessos_eventos`
- o sistema deve privilegiar evento valido de apartamento para caracterizar chegada real
- a mesma credencial deve poder ser provisionada na fechadura do apartamento e nas duas fechaduras do portao do bloco correspondente
- expiracao, revogacao e reprogramacao fazem parte do ciclo logico da credencial

## 11. Regras especiais de eventos e historico

As regras especiais de eventos e historico neste schema logico sao:

- entidades de estado principal nao eliminam necessidade de historico futuro
- `mensagens` sao naturalmente historicas
- `jobs_automacao` sao naturalmente historicos
- `acessos_eventos` sao naturalmente historicos
- `eventos_lpr` sao naturalmente historicos
- o schema logico deve aceitar reprocessamento e idempotencia como diretrizes
- `acessos_eventos` pode chegar antes de um vinculo perfeito com `reservas` ou `acessos_senhas`
- `eventos_lpr` pode chegar antes de um vinculo perfeito com `reservas` ou `placas_autorizadas`
- correlacao posterior nao altera a natureza historica do evento

## 12. Pontos que ficam para o schema fisico

Ficam explicitamente para a proxima etapa:

- tipos SQL exatos
- indices
- constraints fisicas detalhadas
- triggers
- RLS
- estrategias de particionamento ou performance
- migrations
- contratos exatos de webhook e payload

## 13. Decisoes logicas ja assumidas

Este schema logico V1 assume:

- projeto exclusivo do Yes Hotel
- reserva como entidade central
- `bloco_id` armazenado em `reservas` como redundancia logica controlada
- `checkins_digitais` como processo principal por hospedagem
- `pagamentos_operacionais` como registro principal por hospedagem
- `acessos_senhas` como entidade logica da credencial principal
- `senha_operacional` como atributo da credencial
- `acessos_provisionamentos` separado da credencial
- `acessos_eventos` separado da credencial e do provisionamento
- `eventos_lpr` podendo existir antes de vinculacao perfeita
- `cafe_presencas` simples e agregado
- `usuarios_internos` voltados a rastreabilidade e controle operacional

## 14. Duvidas reais que permanecem

As duvidas reais para a proxima etapa sao:

- a redundancia de `bloco_id` em `reservas` deve permanecer no schema fisico ou ser resolvida por derivacao
- os estados finais refinados de `reservas` e `status_operacional_reserva`
- o payload real da TTLock e como ele permitira correlacionar credencial, fechadura e evento
- o payload real do Hits e como identificar alteracoes e cancelamentos
- a politica detalhada de revogacao, expiracao e reprogramacao da credencial
- como mapear com seguranca certos tipos de primeiro acesso
- a granularidade futura de historico de check-in digital
- a granularidade futura de historico de pagamento operacional
- a necessidade futura de multiplas placas por reserva em casos especificos

## 15. Proximos passos

A sequencia recomendada apos este documento e:

1. Revisar e congelar o schema logico V1.
2. Derivar o schema fisico V1.
3. Somente depois pensar em migration fisica.
4. Em seguida, detalhar contratos de integracao e backend com base nos documentos congelados.
