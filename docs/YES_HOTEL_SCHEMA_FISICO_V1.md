# YES HOTEL - Schema Fisico V1

## 1. Objetivo do documento

Este documento converte o schema logico congelado do Yes Hotel em uma estrutura fisica implementavel em PostgreSQL/Supabase.

O objetivo desta etapa e:

- propor tabelas fisicas
- definir colunas fisicas por tabela
- recomendar tipos SQL compativeis com PostgreSQL/Supabase
- registrar PKs, FKs, unicidades e checks principais
- separar tabelas de cadastro, estado operacional principal e historico/eventos
- preparar a base para a migration futura

Este documento ainda nao cria SQL, nao cria migration, nao executa nada no banco, nao define RLS, nao define triggers e nao define endpoints.

## 2. Bases de referencia

Este documento deriva obrigatoriamente de:

- `D:\Automação_Yes_Hotel\docs\YES_HOTEL_FONTE_DA_VERDADE_ARQUITETURA.md`
- `D:\Automação_Yes_Hotel\docs\YES_HOTEL_MODELO_CONCEITUAL_DADOS.md`
- `D:\Automação_Yes_Hotel\docs\YES_HOTEL_SCHEMA_LOGICO_V1.md`

Esses tres documentos estao congelados e prevalecem sobre qualquer interpretacao paralela.

## 3. Principios do schema fisico

Os principios deste schema fisico sao:

- sobriedade na traducao do logico para o fisico
- implementabilidade direta em PostgreSQL/Supabase
- separacao clara entre estado atual e historico/eventos
- simplicidade operacional
- coerencia com a arquitetura congelada
- reserva como pivô principal
- preservacao da separacao entre credencial principal, senha operacional, provisionamentos fisicos e eventos reais
- preparacao para reprocessamento e idempotencia sem inflar o banco prematuramente

## 4. Convencoes fisicas adotadas

As convencoes adotadas neste V1 sao:

- PostgreSQL / Supabase
- nomes em portugues
- `snake_case`
- tabelas no plural
- PK padrao `id`
- `uuid` como tipo preferencial de PK
- FKs no padrao `<entidade_singular>_id`
- timestamps padrao `created_at` e `updated_at` quando fizer sentido
- datas de evento e operacao com nomes descritivos como `ocorreu_em`, `enviado_em`, `preenchido_em`, `agendado_para`, `gerada_em`
- booleans com nomes claros como `ativo`, `pendente_apos_chegada`, `evento_primeiro_acesso`

Abordagem adotada para status:

- neste V1, colunas de status serao documentadas como `text` com dominio controlado
- a decisao final entre `text + check` e `enum fisico PostgreSQL` fica para a etapa de migration
- a documentacao abaixo indica os valores esperados por coluna

Abordagem para colunas opcionais:

- colunas opcionais serao explicitamente marcadas como `nullable`
- colunas operacionais centrais serao marcadas como `not null`

Observacao sobre dados sensiveis:

- alguns campos exigirao cuidado especifico de exibicao, log e exportacao na aplicacao
- este documento nao define ainda criptografia, masking ou RLS

## 5. Estrategia geral de modelagem fisica

A estrategia fisica deste V1 e:

- tabelas de cadastro mestre:
  - `blocos`
  - `portoes`
  - `apartamentos`
  - `fechaduras`
  - `usuarios_internos`

- tabelas de estado operacional principal por hospedagem:
  - `reservas`
  - `checkins_digitais`
  - `pagamentos_operacionais`
  - `acessos_senhas`

- tabelas de apoio relacional:
  - `hospedes`
  - `reserva_hospedes`
  - `placas_autorizadas`
  - `cafe_presencas`

- tabelas de historico, evento ou trilha operacional:
  - `acessos_provisionamentos`
  - `acessos_eventos`
  - `mensagens`
  - `jobs_automacao`
  - `alertas_operacionais`
  - `eventos_lpr`

Essa separacao preserva:

- clareza entre estado atual e ocorrencia historica
- rastreabilidade operacional
- implementacao progressiva sem exigir arquitetura distribuida

## 6. Tabelas fisicas por grupo

### 6.1 Cadastros estruturais

#### `blocos`

Finalidade:

- cadastro estrutural dos blocos fisicos do hotel

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `nome` - `text` - `not null`
- `codigo_portao_referencia` - `text` - `nullable`
- `ativo` - `boolean` - `not null`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- nenhuma

Uniques principais:

- `nome`
- `codigo_portao_referencia`, se for mantido como referencia operacional unica

Checks conceituais importantes:

- nenhum obrigatorio alem de coerencia basica de nulos neste V1

Observacoes:

- `codigo_portao_referencia` nao substitui a tabela `portoes`

#### `portoes`

Finalidade:

- cadastro fisico dos portoes principais dos blocos

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `bloco_id` - `uuid` - `not null`
- `identificador_operacional` - `text` - `not null`
- `ativo` - `boolean` - `not null`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `bloco_id -> blocos(id)`

Uniques principais:

- `bloco_id` no contexto fisico atual do Yes Hotel
- `identificador_operacional`

Checks conceituais importantes:

- nenhum alem de nulabilidade obrigatoria neste V1

Observacoes:

- no contexto atual, cada bloco possui um portao principal

#### `apartamentos`

Finalidade:

- cadastro fisico das unidades de hospedagem

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `bloco_id` - `uuid` - `not null`
- `numero` - `text` - `not null`
- `identificador_operacional` - `text` - `nullable`
- `ativo` - `boolean` - `not null`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `bloco_id -> blocos(id)`

Uniques principais:

- `numero` no contexto fisico atual do hotel
- `identificador_operacional`, se for usado

Checks conceituais importantes:

- nenhum alem de nulabilidade obrigatoria neste V1

Observacoes:

- `numero` pode ser armazenado como `text` para preservar zeros a esquerda ou convencoes operacionais futuras

#### `fechaduras`

Finalidade:

- cadastro fisico das fechaduras de apartamento e portao

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `tipo_fechadura` - `text` - `not null`
- `apartamento_id` - `uuid` - `nullable`
- `portao_id` - `uuid` - `nullable`
- `identificador_externo_ttlock` - `text` - `not null`
- `ativo` - `boolean` - `not null`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `apartamento_id -> apartamentos(id)`
- `portao_id -> portoes(id)`

Uniques principais:

- `identificador_externo_ttlock`

Checks conceituais importantes:

- `tipo_fechadura` com dominio controlado:
  - `apartamento`
  - `portao_externo`
  - `portao_interno`
- quando `tipo_fechadura = apartamento`, `apartamento_id` deve ser obrigatorio e `portao_id` deve ser nulo
- quando `tipo_fechadura in (portao_externo, portao_interno)`, `portao_id` deve ser obrigatorio e `apartamento_id` deve ser nulo

Observacoes:

- este V1 nao detalha payloads tecnicos da TTLock

### 6.2 Operacao principal

#### `reservas`

Finalidade:

- tabela pivô da hospedagem operacional

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `identificador_reserva_externa` - `text` - `nullable`
- `origem_reserva` - `text` - `not null`
- `apartamento_id` - `uuid` - `not null`
- `bloco_id` - `uuid` - `not null`
- `data_checkin_prevista` - `date` - `not null`
- `data_checkout_prevista` - `date` - `not null`
- `status_reserva` - `text` - `not null`
- `status_operacional_reserva` - `text` - `not null`
- `contato_email_principal` - `text` - `nullable`
- `contato_whatsapp_principal` - `text` - `nullable`
- `observacoes_operacionais` - `text` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `apartamento_id -> apartamentos(id)`
- `bloco_id -> blocos(id)`

Uniques principais:

- unique parcial intencional para `(origem_reserva, identificador_reserva_externa)` quando `identificador_reserva_externa` nao for nulo

Checks conceituais importantes:

- `data_checkout_prevista >= data_checkin_prevista`
- `status_reserva` com dominio controlado:
  - `recebida`
  - `confirmada`
  - `cancelada`
  - `em_hospedagem`
  - `encerrada`
- `status_operacional_reserva` com dominio controlado:
  - `aguardando_fnrh`
  - `apta_para_credencial`
  - `credencial_gerada`
  - `chegada_detectada`
  - `com_alerta`
  - `concluida`

Observacoes:

- `data_checkin_prevista` e `data_checkout_prevista` foram modeladas como `date` por serem referencias operacionais de hospedagem, nao timestamps de evento
- `bloco_id` e redundancia fisica controlada derivada do apartamento e nao origem independente
- a coerencia entre `reservas.bloco_id` e `apartamentos.bloco_id` fica documentada aqui e sera fechada na migration

#### `hospedes`

Finalidade:

- cadastro fisico de pessoas vinculadas a hospedagens

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `nome` - `text` - `not null`
- `email` - `text` - `nullable`
- `telefone` - `text` - `nullable`
- `documento` - `text` - `nullable`
- `nacionalidade` - `text` - `nullable`
- `data_nascimento` - `date` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- nenhuma

Uniques principais:

- nenhuma obrigatoria neste V1

Checks conceituais importantes:

- nenhum obrigatorio neste V1

Observacoes:

- contem dados pessoais e deve ser tratado com sobriedade

#### `reserva_hospedes`

Finalidade:

- associacao fisica entre reserva e hospede

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `not null`
- `hospede_id` - `uuid` - `not null`
- `papel_na_reserva` - `text` - `not null`
- `ordem_na_reserva` - `integer` - `nullable`
- `created_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`
- `hospede_id -> hospedes(id)`

Uniques principais:

- `(reserva_id, hospede_id)`

Checks conceituais importantes:

- `papel_na_reserva` com dominio controlado:
  - `principal`
  - `acompanhante`

Observacoes:

- a unique evita duplicidade exata do mesmo hospede na mesma reserva

#### `checkins_digitais`

Finalidade:

- processo principal de check-in digital e FNRH por hospedagem

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `not null`
- `referencia_link_checkin` - `text` - `nullable`
- `status_checkin_digital` - `text` - `not null`
- `enviado_em` - `timestamptz` - `nullable`
- `preenchido_em` - `timestamptz` - `nullable`
- `pendente_apos_chegada` - `boolean` - `not null`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`

Uniques principais:

- `reserva_id`

Checks conceituais importantes:

- `status_checkin_digital` com dominio controlado:
  - `nao_iniciado`
  - `enviado`
  - `preenchido`
  - `pendente_apos_chegada`

Observacoes:

- `status_checkin_digital` e o elemento canonico do estado
- `pendente_apos_chegada` e auxiliar/derivavel e permanece por clareza operacional
- a unique em `reserva_id` representa o processo principal atual por hospedagem, e nao historico completo
- recomenda-se default logico inicial `false` para `pendente_apos_chegada`

#### `pagamentos_operacionais`

Finalidade:

- registro principal de pagamento operacional por hospedagem

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `not null`
- `status_pagamento_operacional` - `text` - `not null`
- `origem_status` - `text` - `nullable`
- `atualizado_em` - `timestamptz` - `not null`
- `observacao` - `text` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`

Uniques principais:

- `reserva_id`

Checks conceituais importantes:

- `status_pagamento_operacional` com dominio controlado:
  - `pendente`
  - `confirmado`
  - `dispensado`
  - `indefinido`

Observacoes:

- mantem o tema pagamento como status operacional, sem modulo financeiro
- a unique em `reserva_id` representa o registro principal atual por hospedagem, e nao historico completo

### 6.3 Credenciais e acesso

#### `acessos_senhas`

Finalidade:

- representar fisicamente a credencial principal da reserva

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `not null`
- `status_credencial` - `text` - `not null`
- `senha_operacional` - `text` - `not null`
- `validade_inicio` - `timestamptz` - `not null`
- `validade_fim` - `timestamptz` - `not null`
- `gerada_em` - `timestamptz` - `not null`
- `enviada_ao_hospede_em` - `timestamptz` - `nullable`
- `motivo_revogacao` - `text` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`

Uniques principais:

- `reserva_id`

Checks conceituais importantes:

- `validade_inicio <= validade_fim`
- `status_credencial` com dominio controlado:
  - `pendente`
  - `gerada`
  - `provisionando`
  - `ativa`
  - `expirada`
  - `revogada`
  - `erro`

Observacoes:

- `senha_operacional` e atributo sensivel
- armazenamento, exibicao, logs e exportacao devem receber tratamento especifico na aplicacao
- esta tabela representa a credencial principal, nao o historico de acessos
- a unique em `reserva_id` representa a credencial principal corrente da reserva/hospedagem

#### `acessos_provisionamentos`

Finalidade:

- representar a distribuicao fisica da credencial nas fechaduras

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `acesso_senha_id` - `uuid` - `not null`
- `fechadura_id` - `uuid` - `not null`
- `status_provisionamento` - `text` - `not null`
- `provisionado_em` - `timestamptz` - `nullable`
- `ultima_tentativa_em` - `timestamptz` - `nullable`
- `erro_ultima_tentativa` - `text` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `acesso_senha_id -> acessos_senhas(id)`
- `fechadura_id -> fechaduras(id)`

Uniques principais:

- `(acesso_senha_id, fechadura_id)`

Checks conceituais importantes:

- `status_provisionamento` com dominio controlado:
  - `pendente`
  - `provisionado`
  - `erro`
  - `revogado`

Observacoes:

- a tabela representa a distribuicao fisica da credencial e nao deve ser colapsada com a tabela da credencial principal

#### `acessos_eventos`

Finalidade:

- armazenar eventos reais e historicos de acesso das fechaduras

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `nullable`
- `fechadura_id` - `uuid` - `not null`
- `acesso_senha_id` - `uuid` - `nullable`
- `tipo_evento_acesso` - `text` - `not null`
- `ocorreu_em` - `timestamptz` - `not null`
- `evento_primeiro_acesso` - `boolean` - `not null`
- `origem_evento` - `text` - `nullable`
- `payload_referencia` - `jsonb` - `nullable`
- `created_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`
- `fechadura_id -> fechaduras(id)`
- `acesso_senha_id -> acessos_senhas(id)`

Uniques principais:

- nenhuma obrigatoria neste V1

Checks conceituais importantes:

- `tipo_evento_acesso` com dominio controlado:
  - `entrada_validada`
  - `tentativa_negada`
  - `revogacao_detectada`
  - `evento_nao_classificado`

Observacoes:

- tabela historica
- `reserva_id` e `acesso_senha_id` podem ser nulos para suportar correlacao posterior
- `evento_primeiro_acesso` e marcador do sistema, nao necessariamente informacao pronta da integracao externa
- `payload_referencia` e recomendado como `jsonb` por ser um payload semi-estruturado de evento externo
- recomenda-se default logico inicial `false` para `evento_primeiro_acesso`
- `jsonb` aqui e auxiliar para rastreabilidade tecnica e nao deve virar fonte da regra principal

### 6.4 Comunicacao e automacao

#### `mensagens`

Finalidade:

- armazenar historico operacional de comunicacoes

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `not null`
- `tipo_mensagem` - `text` - `not null`
- `canal_mensagem` - `text` - `not null`
- `destinatario` - `text` - `not null`
- `status_mensagem` - `text` - `not null`
- `conteudo_referencia` - `text` - `nullable`
- `enviada_em` - `timestamptz` - `nullable`
- `retorno_provedor` - `jsonb` - `nullable`
- `tentativas` - `integer` - `not null`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`

Uniques principais:

- nenhuma obrigatoria neste V1

Checks conceituais importantes:

- `canal_mensagem` com dominio controlado:
  - `email`
  - `whatsapp`
- `status_mensagem` com dominio controlado:
  - `pendente`
  - `enviada`
  - `entregue`
  - `erro`
- `tentativas >= 0`

Observacoes:

- tabela historica
- `status_mensagem` foi mantido simples e coerente com o V1
- `retorno_provedor` e recomendado como `jsonb` por ser retorno semi-estruturado
- recomenda-se default logico inicial `0` para `tentativas`
- `jsonb` aqui e auxiliar para rastreabilidade tecnica e nao deve virar fonte da regra principal

#### `jobs_automacao`

Finalidade:

- armazenar agendamentos, execucoes, retries e reprocessamentos

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `nullable`
- `tipo_job` - `text` - `not null`
- `status_job` - `text` - `not null`
- `agendado_para` - `timestamptz` - `not null`
- `executado_em` - `timestamptz` - `nullable`
- `tentativas` - `integer` - `not null`
- `erro_ultima_execucao` - `text` - `nullable`
- `referencia_entidade` - `text` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`

Uniques principais:

- nenhuma obrigatoria neste V1

Checks conceituais importantes:

- `status_job` com dominio controlado:
  - `pendente`
  - `executando`
  - `concluido`
  - `erro`
  - `cancelado`
- `tentativas >= 0`

Observacoes:

- tabela historica/operacional
- `referencia_entidade` podera ser refinada em etapa posterior, inclusive no schema fisico final da migration
- recomenda-se default logico inicial `0` para `tentativas`

### 6.5 Alertas

#### `alertas_operacionais`

Finalidade:

- armazenar excecoes operacionais rastreaveis

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `nullable`
- `tipo_alerta` - `text` - `not null`
- `severidade` - `text` - `not null`
- `status_alerta` - `text` - `not null`
- `descricao_resumida` - `text` - `not null`
- `aberto_em` - `timestamptz` - `not null`
- `resolvido_em` - `timestamptz` - `nullable`
- `resolvido_por_usuario_interno_id` - `uuid` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`
- `resolvido_por_usuario_interno_id -> usuarios_internos(id)`

Uniques principais:

- nenhuma obrigatoria neste V1

Checks conceituais importantes:

- `severidade` com dominio controlado:
  - `baixa`
  - `media`
  - `alta`
  - `critica`
- `status_alerta` com dominio controlado:
  - `aberto`
  - `em_tratamento`
  - `resolvido`
  - `cancelado`

Observacoes:

- `reserva_id` foi mantido `nullable` para permitir eventuais alertas gerais, mas isso deve ser validado antes da migration

### 6.6 Veiculos e LPR

#### `placas_autorizadas`

Finalidade:

- armazenar placas autorizadas operacionalmente para reserva

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `not null`
- `hospede_id` - `uuid` - `nullable`
- `placa` - `text` - `not null`
- `origem_cadastro` - `text` - `not null`
- `ativa` - `boolean` - `not null`
- `autorizada_inicio` - `timestamptz` - `nullable`
- `autorizada_fim` - `timestamptz` - `nullable`
- `criada_por_usuario_interno_id` - `uuid` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`
- `hospede_id -> hospedes(id)`
- `criada_por_usuario_interno_id -> usuarios_internos(id)`

Uniques principais:

- nenhuma obrigatoria neste V1

Checks conceituais importantes:

- `origem_cadastro` com dominio controlado:
  - `fnrh`
  - `manual`
- se ambas existirem, `autorizada_fim >= autorizada_inicio`

Observacoes:

- recomenda-se armazenar `placa` normalizada em maiusculas e sem mascara
- isso pode ser padronizado definitivamente na migration ou na aplicacao

#### `eventos_lpr`

Finalidade:

- armazenar leituras e validacoes operacionais do LPR

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `placa_lida` - `text` - `not null`
- `reserva_id` - `uuid` - `nullable`
- `placa_autorizada_id` - `uuid` - `nullable`
- `ocorreu_em` - `timestamptz` - `not null`
- `resultado_validacao` - `text` - `not null`
- `acao_executada` - `text` - `nullable`
- `origem_equipamento` - `text` - `nullable`
- `created_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`
- `placa_autorizada_id -> placas_autorizadas(id)`

Uniques principais:

- nenhuma obrigatoria neste V1

Checks conceituais importantes:

- `resultado_validacao` com dominio controlado:
  - `autorizada`
  - `rejeitada`
  - `nao_encontrada`
  - `pendente_correlacao`

Observacoes:

- tabela historica/eventos
- `reserva_id` e `placa_autorizada_id` podem ser nulos para suportar correlacao posterior

### 6.7 Cafe da manha

#### `cafe_presencas`

Finalidade:

- armazenar o controle operacional simples do cafe por dia

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `reserva_id` - `uuid` - `not null`
- `data_operacao` - `date` - `not null`
- `apartamento_id` - `uuid` - `not null`
- `quantidade_esperada` - `integer` - `not null`
- `quantidade_presente` - `integer` - `not null`
- `status_operacional_cafe` - `text` - `nullable`
- `registrado_por_usuario_interno_id` - `uuid` - `nullable`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- `reserva_id -> reservas(id)`
- `apartamento_id -> apartamentos(id)`
- `registrado_por_usuario_interno_id -> usuarios_internos(id)`

Uniques principais:

- `(reserva_id, data_operacao)` como sugestao principal para o modelo operacional inicial agregado

Checks conceituais importantes:

- `quantidade_esperada >= 0`
- `quantidade_presente >= 0`
- `quantidade_presente <= quantidade_esperada`
- `status_operacional_cafe`, se usado, com dominio controlado:
  - `nao_iniciado`
  - `parcial`
  - `concluido`

Observacoes:

- `apartamento_id` funciona como apoio operacional e deve permanecer coerente com a reserva vinculada
- nao representa controle individualizado por hospede neste V1
- recomenda-se default logico inicial `0` para `quantidade_presente`

### 6.8 Usuarios internos

#### `usuarios_internos`

Finalidade:

- armazenar usuarios humanos com atuacao no sistema

Colunas fisicas propostas:

- `id` - `uuid` - `not null`
- `nome` - `text` - `not null`
- `email_login` - `text` - `not null`
- `perfil_usuario` - `text` - `not null`
- `ativo` - `boolean` - `not null`
- `created_at` - `timestamptz` - `not null`
- `updated_at` - `timestamptz` - `not null`

PK:

- `id`

FKs:

- nenhuma

Uniques principais:

- `email_login`

Checks conceituais importantes:

- `perfil_usuario` com dominio controlado:
  - `operacional`
  - `administrativo`

Observacoes:

- este V1 nao detalha perfis finos de permissao

## 7. Regras fisicas de integridade principais

As principais regras fisicas de integridade sugeridas para o V1 sao:

- unique em `blocos.nome`
- unique em `portoes.bloco_id` no contexto fisico atual do Yes Hotel
- unique em `portoes.identificador_operacional`
- unique em `apartamentos.numero` no contexto fisico atual do hotel
- unique em `fechaduras.identificador_externo_ttlock`
- unique parcial em `(origem_reserva, identificador_reserva_externa)` quando houver identificador externo
- unique em `checkins_digitais.reserva_id`
- unique em `pagamentos_operacionais.reserva_id`
- unique em `acessos_senhas.reserva_id`
- unique em `(acesso_senha_id, fechadura_id)` em `acessos_provisionamentos`
- unique em `(reserva_id, hospede_id)` em `reserva_hospedes`
- unique em `(reserva_id, data_operacao)` em `cafe_presencas`, se o modelo operacional inicial agregado for mantido
- unique em `usuarios_internos.email_login`

FKs principais:

- coerencia estrutural entre `portoes` e `blocos`
- coerencia estrutural entre `apartamentos` e `blocos`
- coerencia estrutural entre `fechaduras` e `apartamentos/portoes`
- reserva apontando para apartamento e bloco
- entidades operacionais apontando para `reservas`
- entidades de historico apontando para a entidade principal correspondente quando houver correlacao segura

Checks principais:

- coerencia estrutural de `fechaduras` por tipo
- `data_checkout_prevista >= data_checkin_prevista`
- `validade_inicio <= validade_fim`
- `quantidade_presente <= quantidade_esperada`
- domínios controlados de status e tipos
- coerencia entre `reservas.bloco_id` e `apartamentos.bloco_id`

Expectativas fisicas adicionais de nulabilidade e defaults logicos:

- booleans operacionais centrais como `ativo`, `pendente_apos_chegada` e `evento_primeiro_acesso` devem ser `not null`
- contadores operacionais como `tentativas` e `quantidade_presente` devem ser `not null`
- defaults logicos iniciais recomendados:
  - `ativo = true` nas tabelas de cadastro e usuarios internos
  - `pendente_apos_chegada = false`
  - `evento_primeiro_acesso = false`
  - `tentativas = 0`
  - `quantidade_presente = 0`

## 8. Campos sensiveis e observacoes de seguranca

Campos sensiveis identificados neste V1:

- `hospedes.documento`
- `hospedes.data_nascimento`
- `reservas.contato_email_principal`
- `reservas.contato_whatsapp_principal`
- `acessos_senhas.senha_operacional`

Observacoes de seguranca:

- sao campos sensiveis e o acesso deve ser controlado pela aplicacao
- devem receber cuidado especial em logs, exportacoes, telas e mecanismos de suporte
- `senha_operacional` exige cuidado adicional por impactar acesso fisico
- este documento nao define ainda RLS, criptografia, masking ou politica de auditoria detalhada

## 9. Pontos que ficam para a migration

Ficam explicitamente para a etapa de migration:

- SQL final
- decisao final entre `text + check` e enums fisicos
- indices
- triggers de `updated_at`
- coerencia automatizada da redundancia `reservas.bloco_id`
- RLS
- politicas de criptografia e masking na aplicacao
- definicao final das colunas de payload de webhook
- defaults finais

## 10. Decisoes fisicas ja assumidas

Este documento assume:

- `uuid` para ids
- `created_at` e `updated_at` como timestamps padrao quando fizer sentido
- separacao entre tabelas de estado principal e tabelas de historico/evento
- `text` com dominio controlado para statuses neste V1
- `jsonb` recomendado quando houver payload ou retorno semi-estruturado
- `date` para datas previstas de hospedagem e operacao diaria
- `timestamptz` para eventos e mudancas operacionais
- `reservas` como pivô fisico do modelo

## 11. Duvidas reais que permanecem

As duvidas reais para a proxima etapa sao:

- a redundancia fisica definitiva ou nao de `bloco_id` em `reservas`
- `date` versus `timestamptz` em alguns campos operacionais de fronteira
- `jsonb` versus `text` em `payload_referencia` e `retorno_provedor`
- refinamento final dos estados operacionais
- estrategia futura de masking ou encryption para `senha_operacional`
- politica final para multiplas placas por reserva
- necessidade futura de tabelas historicas separadas para check-in e pagamento

## 12. Proximos passos

A sequencia recomendada apos este documento e:

1. Revisar e congelar o schema fisico V1.
2. So entao gerar a migration SQL inicial.
3. Revisar a migration antes de qualquer execucao.
4. Depois detalhar contratos de integracao e backend com base nos documentos congelados.
