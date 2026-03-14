# YES HOTEL - Modelo Conceitual de Dados

## 1. Objetivo do documento

Este documento traduz a Fonte da Verdade Arquitetural V1 do Yes Hotel em um modelo conceitual de dados.

O objetivo desta etapa e:

- organizar as entidades conceituais do sistema
- registrar o papel de cada entidade
- explicitar relacoes e cardinalidades principais
- preparar a transicao para schema logico e, depois, schema fisico

Este documento ainda nao define SQL, migrations, constraints tecnicas detalhadas, tipos de coluna ou implementacao fisica.

## 2. Base de referencia

Este documento deriva obrigatoriamente do arquivo:

`D:\Automação_Yes_Hotel\docs\YES_HOTEL_FONTE_DA_VERDADE_ARQUITETURA.md`

Esse arquivo esta congelado como Fonte da Verdade Arquitetural V1 do Yes Hotel e deve prevalecer sobre qualquer interpretacao paralela.

## 3. Principios de modelagem

Os principios de modelagem desta etapa sao:

- reserva no centro do modelo
- simplicidade operacional acima de sofisticacao desnecessaria
- separacao clara entre entidades de cadastro, entidades de estado e entidades de evento
- separacao clara entre credencial logica, senha operacional e provisionamento fisico
- modelagem conceitual sem detalhamento tecnico prematuro
- nao inflar o modelo com microentidades sem necessidade arquitetural
- preservar reprocessamento, auditoria operacional e tratamento de excecoes
- manter aderencia estrita ao contexto exclusivo do Yes Hotel

## 4. Entidade central do sistema

A entidade central do sistema e `reservas`.

A reserva e o pivô operacional do modelo, pois conecta:

- apartamento e bloco da hospedagem
- hospedes vinculados
- processo de check-in digital e FNRH
- pagamento operacional
- credencial de acesso principal
- provisionamentos fisicos de acesso
- eventos de acesso
- mensagens e automacoes
- alertas operacionais
- placas autorizadas
- operacao de cafe da manha

Demais entidades orbitam a reserva de forma direta ou indireta.

## 5. Visao geral dos grupos de entidades

Os grupos conceituais do modelo sao:

- estrutura fisica
- operacao principal de hospedagem
- acesso e credenciais
- comunicacao e automacao
- alertas operacionais
- veiculos e LPR
- cafe da manha
- usuarios internos

## 6. Entidades estruturais

### `blocos`

Representa os blocos fisicos do hotel.

Existe para:

- agrupar apartamentos
- associar o portao correspondente ao bloco
- permitir derivar as necessidades de acesso da reserva a partir da localizacao fisica

Relacoes principais:

- um bloco possui apartamentos
- no contexto fisico atual do Yes Hotel, um bloco possui um portao principal

### `apartamentos`

Representa as unidades de hospedagem do hotel.

Existe para:

- localizar fisicamente a reserva
- definir a unidade onde ocorre a hospedagem
- vincular a fechadura principal do apartamento

Relacoes principais:

- apartamento pertence a um bloco
- apartamento possui uma fechadura principal
- reserva pertence a um apartamento

### `portoes`

Representa os acessos principais dos blocos.

Existe para:

- modelar o acesso compartilhado por bloco
- associar as fechaduras externa e interna do portao
- permitir provisionamento fisico da credencial da reserva nos pontos corretos

Relacoes principais:

- portao pertence a um bloco
- portao possui fechaduras vinculadas

### `fechaduras`

Representa os dispositivos fisicos de acesso, especialmente da TTLock.

Existe para:

- identificar os destinos fisicos de provisionamento
- diferenciar fechaduras de apartamento e de portao
- registrar a origem fisica de eventos de acesso

Relacoes principais:

- fechadura pode estar vinculada a um apartamento
- fechadura pode estar vinculada a um portao
- fechadura pode receber provisionamentos de credenciais
- fechadura pode originar eventos de acesso

## 7. Entidades operacionais principais

### `reservas`

Representa a hospedagem operacional central do sistema.

Papel conceitual:

- consolidar a hospedagem recebida de integracoes externas
- vincular apartamento, bloco, periodo e estados operacionais
- servir como ancora para comunicacao, acesso, alertas e automacoes

Motivo para existir separadamente:

- e a entidade principal do dominio
- organiza o restante do modelo em torno de uma hospedagem concreta

### `hospedes`

Representa as pessoas vinculadas a hospedagens.

Papel conceitual:

- concentrar a identidade conceitual dos hospedes
- permitir reutilizacao da mesma pessoa em reservas diferentes, quando aplicavel

Motivo para existir separadamente:

- hospede nao deve ser colapsado dentro da reserva
- a modelagem precisa suportar uma ou mais pessoas por hospedagem

### `reserva_hospedes`

Representa a associacao entre reservas e hospedes.

Papel conceitual:

- modelar a composicao de hospedes por reserva
- permitir indicar hospede principal e demais vinculados no schema logico, se necessario

Motivo para existir separadamente:

- resolve a associacao entre reserva e um ou mais hospedes
- evita acoplamento improprio entre dados da reserva e dados da pessoa

### `checkins_digitais`

Representa o processo de pre check-in e FNRH associado a uma reserva.

Papel conceitual:

- registrar o fluxo operacional do FNRH
- armazenar o estado do processo digital da ficha
- servir de base para comunicacoes, pendencias e automacoes

Motivo para existir separadamente:

- check-in digital tem ciclo de vida proprio
- nem toda mudanca no FNRH deve ser tratada como mudanca direta da reserva
- o modelo conceitual trata um processo principal por hospedagem, sem impedir historico futuro mais detalhado no schema logico

Estado conceitual minimo esperado:

- nao iniciado
- enviado
- preenchido
- pendente apos chegada

### `pagamentos_operacionais`

Representa o estado operacional de pagamento da reserva.

Papel conceitual:

- indicar se a hospedagem esta operacionalmente liberada ou pendente do ponto de vista de pagamento
- sustentar alertas internos sem criar um modulo financeiro completo

Motivo para existir separadamente:

- pagamento e uma dimensao operacional da reserva
- seu ciclo de validacao pode evoluir sem transformar a reserva em um objeto excessivamente inflado
- o modelo conceitual assume um registro principal por hospedagem, sem impedir historico futuro mais detalhado no schema logico

Estado conceitual minimo esperado:

- pendente
- confirmado
- dispensado
- indefinido

## 8. Entidades de acesso e credenciais

### `acessos_senhas`

Representa a credencial de acesso principal da reserva.

Papel conceitual:

- modelar a unica credencial principal associada a uma hospedagem
- registrar o estado conceitual dessa credencial
- sustentar regras de expiracao, revogacao ou reprogramacao

Esclarecimento obrigatorio:

- embora o nome conceitual `acessos_senhas` seja mantido por coerencia com a arquitetura congelada, esta entidade representa a credencial de acesso principal da reserva
- a senha entregue ao hospede e a materializacao operacional dessa credencial
- o naming pode ser refinado no schema logico, se isso melhorar a precisao terminologica, sem mudar a decisao conceitual

Motivo para existir separadamente:

- a credencial logica nao deve ser confundida com eventos de acesso
- a credencial logica nao deve ser confundida com cada destino fisico de provisionamento

### `acessos_provisionamentos`

Representa a aplicacao fisica da credencial principal da reserva nas fechaduras necessarias.

Papel conceitual:

- separar a credencial logica de sua distribuicao fisica
- registrar que a mesma credencial precisa ser aplicada em multiplos destinos
- permitir acompanhar sucesso, falha, reprocessamento e estado de cada provisionamento

Motivo para existir separadamente:

- uma unica credencial pode precisar ser provisionada em varias fechaduras
- o modelo precisa distinguir claramente credencial principal e provisionamentos fisicos

Destinos fisicos tipicos por reserva:

- fechadura do apartamento
- fechadura externa do portao do bloco
- fechadura interna do portao do bloco

### `acessos_eventos`

Representa as ocorrencias reais de uso das fechaduras.

Papel conceitual:

- registrar eventos fisicos recebidos das fechaduras
- permitir detectar primeiro acesso
- sustentar analise operacional de entrada, divergencia e historico de uso

Motivo para existir separadamente:

- evento de acesso nao e nem a credencial nem o provisionamento
- evento e uma ocorrencia real produzida pelo uso da infraestrutura fisica

Diretriz conceitual importante:

- o conjunto de acesso deve permitir tratar primeiro acesso
- a chegada real deve ser caracterizada preferencialmente pelo primeiro evento valido na fechadura do apartamento
- eventos de portao podem ser registrados, mas nao devem por padrao substituir a chegada real ao apartamento sem regra tecnica explicita
- se a integracao nao permitir essa distincao com seguranca, isso podera ser refinado no schema logico e na regra de processamento, sem mudar a decisao conceitual

## 9. Entidades de comunicacao e automacao

### `mensagens`

Representa o historico operacional de comunicacao com o hospede.

Papel conceitual:

- registrar tentativas de envio
- registrar canal utilizado
- registrar resultado operacional da comunicacao
- sustentar auditoria minima de mensagens automaticas e manuais

Motivo para existir separadamente:

- comunicacao tem vida propria dentro da operacao
- historico de mensagens nao deve ficar diluido em reserva ou em jobs

### `jobs_automacao`

Representa agendamentos, execucoes, retries e reprocessamentos operacionais.

Papel conceitual:

- suportar automacoes por eventos e jobs agendados
- registrar tentativas, falhas e novas execucoes
- sustentar rastreabilidade operacional minima

Motivo para existir separadamente:

- automacao nao deve ser apenas comportamento implícito do sistema
- o modelo precisa suportar acompanhamento e reprocessamento

## 10. Entidades de alertas operacionais

### `alertas_operacionais`

Representa as excecoes que exigem visibilidade e possivel acao humana.

Papel conceitual:

- sustentar o painel operacional de excecoes
- registrar abertura, acompanhamento e encerramento de problemas operacionais
- organizar pendencias relevantes para a equipe

Motivo para existir separadamente:

- alerta nao e operacao normal
- o sistema precisa distinguir estado regular da reserva de excecoes operacionais

Exemplos de uso:

- entrada sem FNRH
- entrada sem pagamento
- falha na geracao da credencial
- falha no envio de mensagem
- divergencia de acesso
- placa rejeitada

## 11. Entidades de veiculos e LPR

### `placas_autorizadas`

Representa a autorizacao operacional de uma placa vinculada a uma reserva ativa.

Papel conceitual:

- registrar a placa esperada ou autorizada para acesso veicular
- permitir origem via FNRH ou cadastro manual
- sustentar validacao contra reserva ativa

Motivo para existir separadamente:

- placa autorizada nao e um evento
- a autorizacao precisa existir antes da leitura do LPR

### `eventos_lpr`

Representa ocorrencias recebidas do sistema de leitura de placas.

Papel conceitual:

- registrar leituras de placa
- registrar resultado operacional da leitura
- sustentar decisao posterior sobre abertura de portao e auditoria de acesso veicular
- permitir vinculacao a uma reserva quando houver correspondencia operacional valida

Motivo para existir separadamente:

- evento de leitura nao deve ser confundido com cadastro da placa autorizada
- leitura e autorizacao sao conceitos diferentes

## 12. Entidades de cafe da manha

### `cafe_presencas`

Representa o controle operacional do cafe da manha.

Papel conceitual:

- sustentar uma lista simples da operacao do dia
- registrar comparecimento em nivel operacional
- permitir contagem de esperados, presentes e faltantes

Motivo para existir separadamente:

- cafe da manha tem operacao propria
- o modelo inicial deve continuar simples, sem virar modulo detalhado de consumo

Diretriz obrigatoria desta fase:

- o modelo inicial e simples
- o foco esta em data, reserva, apartamento, quantidade esperada e quantidade presente
- nao existe obrigatoriedade de individualizacao por hospede nesta etapa

## 13. Entidades de usuarios internos

### `usuarios_internos`

Representa os usuarios humanos do sistema.

Papel conceitual:

- permitir rastreabilidade
- registrar autoria de ajustes operacionais controlados
- apoiar resolucao de alertas
- sustentar override operacional controlado, quando autorizado

Motivo para existir separadamente:

- o sistema precisa distinguir a operacao automatica da intervencao humana
- acoes sensiveis precisam ser atribuiveis conceitualmente a um usuario interno

## 14. Relacoes conceituais

Relacoes conceituais principais:

- bloco possui apartamentos
- bloco possui portao
- portao possui fechaduras
- apartamento possui fechadura
- reserva pertence a apartamento
- reserva herda o bloco a partir do apartamento
- reserva possui hospedes por meio de `reserva_hospedes`
- reserva possui processo de check-in digital por meio de `checkins_digitais`
- reserva possui pagamento operacional por meio de `pagamentos_operacionais`
- reserva possui credencial de acesso principal por meio de `acessos_senhas`
- credencial possui provisionamentos fisicos por meio de `acessos_provisionamentos`
- fechaduras recebem provisionamentos de credenciais
- reserva possui eventos de acesso por meio de `acessos_eventos`
- reserva possui mensagens
- reserva possui jobs de automacao
- reserva possui alertas operacionais
- reserva pode possuir placas autorizadas
- reserva pode possuir eventos de leitura LPR
- reserva participa do controle de cafe por meio de `cafe_presencas`
- usuarios internos podem atuar sobre alertas, placas, overrides e registros operacionais

## 15. Cardinalidades principais

As cardinalidades conceituais principais sao:

- um bloco possui muitos apartamentos
- no contexto fisico atual do Yes Hotel, um bloco possui um portao principal
- um portao possui duas fechaduras principais de referencia operacional
- um apartamento possui uma fechadura principal
- uma reserva pertence a um apartamento
- uma reserva pode possuir um ou mais hospedes
- um hospede pode participar de uma ou mais reservas, conforme a evolucao operacional
- uma reserva possui um processo principal de check-in digital por hospedagem, ainda que esse processo tenha historico proprio
- uma reserva possui um registro principal de pagamento operacional por hospedagem, ainda que esse registro possa evoluir em estado
- uma reserva possui no maximo uma credencial principal ativa por hospedagem
- uma credencial pode ser provisionada em multiplas fechaduras
- uma fechadura pode receber muitos provisionamentos ao longo do tempo
- uma reserva pode possuir muitos eventos de acesso
- uma reserva pode possuir muitas mensagens
- uma reserva pode possuir muitos jobs de automacao
- uma reserva pode possuir muitos alertas operacionais
- uma reserva pode possuir zero ou muitas placas autorizadas
- uma reserva pode possuir zero ou muitos eventos LPR
- uma reserva pode possuir registros de cafe conforme a operacao do dia

## 16. Regras conceituais criticas

As regras conceituais criticas deste modelo sao:

- reserva e o pivô operacional do sistema
- nao existem multiplas credenciais principais para a mesma reserva na mesma hospedagem
- a senha do hospede nao e uma entidade separada da credencial; e sua forma operacional de uso
- provisionamento fisico deve ser separado da credencial logica
- eventos de acesso devem ser separados do cadastro da credencial
- primeiro acesso deve ser tratavel no conjunto de eventos de acesso
- a chegada real deve privilegiar o evento valido da fechadura do apartamento
- pagamento e um status operacional, nao um modulo financeiro completo
- cafe da manha comeca simples
- alerta operacional e entidade de excecao, nao de operacao normal
- mensagens e jobs devem existir como entidades distintas para preservar rastreabilidade
- o modelo deve permitir reprocessamento e idempotencia sem inflar o desenho conceitual

## 17. Decisoes de modelagem ja assumidas

Este documento assume como decisoes de modelagem:

- projeto exclusivo do Yes Hotel
- aderencia obrigatoria a Fonte da Verdade Arquitetural V1
- reserva como entidade central
- separacao entre entidade estrutural, entidade operacional e entidade de evento
- separacao entre credencial principal, provisionamento fisico e evento de acesso
- manutencao do nome conceitual `acessos_senhas` por continuidade arquitetural
- uso de `acessos_provisionamentos` como entidade distinta para evitar colapso conceitual do acesso
- pagamento tratado apenas como dimensao operacional
- cafe da manha tratado inicialmente de forma agregada e simples
- usuarios internos modelados para rastreabilidade e apoio operacional

## 18. Pontos ainda dependentes de definicao futura

Os pontos reais que permanecem para a proxima etapa sao:

- estados finais refinados de reservas
- estados finais refinados de check-in digital e pagamento operacional
- contrato concreto de entrada e sincronizacao do Hits
- detalhe real da API TTLock para provisionamento, retorno e eventos
- como distinguir tecnicamente certos tipos de evento de acesso com seguranca
- detalhe do provedor e retornos do WhatsApp Business
- detalhe tecnico da integracao de LPR e cameras
- politica refinada de expiracao, revogacao e reprogramacao da credencial
- criterio final de override operacional em casos excepcionais

## 19. Proximos passos apos este documento

A sequencia recomendada apos este documento e:

1. Derivar o schema logico a partir deste modelo conceitual.
2. Definir contratos de integracao para Hits, TTLock, mensagens e LPR.
3. Mapear o conjunto de eventos internos e jobs de automacao.
4. Converter o schema logico em schema fisico.
5. Implementar backend e automacoes de acordo com os documentos congelados.
