# YES HOTEL - Fonte da Verdade Arquitetural

## 1. Objetivo do sistema

Este documento estabelece a fonte da verdade arquitetural inicial do sistema de automacao do Yes Hotel.

O objetivo do sistema e substituir o software atual da Tag integrado ao Hits PMS/CRM por uma plataforma propria, exclusiva do Yes Hotel, capaz de automatizar praticamente toda a operacao do hotel com foco em robustez, simplicidade operacional e minima intervencao humana.

O sistema deve permitir que:

- reservas entrem automaticamente
- hospedes recebam orientacoes automaticamente
- o pre check-in e o FNRH sejam conduzidos de forma digital
- a credencial de acesso da reserva seja gerada e entregue ao hospede por meio de sua senha correspondente
- o acesso fisico seja controlado com base na reserva ativa
- a equipe atue principalmente em excecoes operacionais

Este documento deve ser consultado obrigatoriamente antes de qualquer modelagem de banco, endpoint, automacao, integracao ou interface.

## 2. Escopo

Faz parte do escopo atual do sistema:

- ingestao de reservas vindas do Hits PMS
- controle operacional de reservas e hospedagens
- cadastro e consolidacao de hospedes vinculados a reservas
- controle de contatos disponiveis para comunicacao
- check-in digital e FNRH
- geracao de uma credencial de acesso unica por reserva/hospedagem
- provisionamento da mesma credencial nas fechaduras aplicaveis
- controle de acesso de apartamentos e portoes
- registro e tratamento de eventos de acesso
- tratamento operacional de pagamento como status da reserva
- comunicacao automatica por email e WhatsApp
- historico de comunicacao
- tratamento operacional de placas autorizadas
- preparacao para integracao futura com LPR
- painel operacional focado em excecoes
- painel de reservas e hospedes
- painel simples de cafe da manha
- cadastro manual de placa por operador
- automacoes, jobs e reprocessamentos operacionais

## 3. Fora de escopo neste momento

Nao faz parte do escopo atual:

- modelagem SQL detalhada
- migrations
- implementacao de tabelas
- codigo de integracao concreto
- definicao tecnica final da API do Hits
- definicao tecnica final da API TTLock
- escolha final do provedor de WhatsApp Business
- implementacao fisica de corte de energia
- detalhamento tecnico concreto do LPR e das cameras
- modulo financeiro complexo
- integracao com pagamentos reais
- microservicos
- qualquer estrutura compartilhada com outros projetos

## 4. Contexto operacional do hotel

O Yes Hotel busca operar de forma quase autonoma. A reserva entra por sistema externo, o hospede recebe orientacoes, preenche o check-in digital quando aplicavel, recebe a senha correspondente a sua credencial de acesso e utiliza os acessos fisicos sem depender da equipe para o fluxo padrao.

O foco operacional da equipe interna deve ser:

- acompanhar excecoes
- tratar falhas de automacao
- agir em casos de ausencia de FNRH
- agir em casos de ausencia de pagamento
- acompanhar divergencias de acesso
- apoiar situacoes manuais e overrides operacionais

O sistema deve ser desenhado para operar com confiabilidade mesmo quando integracoes externas apresentarem falhas temporarias.

## 5. Estrutura fisica do hotel

O hotel possui 40 apartamentos divididos em dois blocos:

### Bloco 1

- apartamentos 01 a 20
- portao identificado como 1947

### Bloco 2

- apartamentos 21 a 40
- portao identificado como 1967

Cada bloco possui um portao com duas fechaduras TTLock:

- fechadura do lado externo
- fechadura do lado interno

Cada apartamento possui sua propria fechadura TTLock.

Implicacao arquitetural:

- a localizacao fisica da reserva determina o bloco
- o bloco determina o portao correspondente
- a reserva deve herdar a necessidade de acesso ao apartamento e ao par de fechaduras do portao do bloco

## 6. Principios de arquitetura

Os principios obrigatorios deste projeto sao:

1. Nao criar tabelas desnecessarias.
2. Nao inventar estrutura sem base no contexto definido.
3. Priorizar simplicidade operacional.
4. Priorizar robustez antes de sofisticacao.
5. Garantir reprocessamento em caso de falha.
6. Integracoes externas nao podem ser a fonte da verdade.
7. O nucleo interno do Yes Hotel e a fonte da verdade do sistema.
8. O sistema deve ser modular, mas sem fragmentacao excessiva.
9. Evitar microservicos.
10. Preferir monolito modular bem organizado.
11. Separar claramente nucleo operacional, integracoes externas, automacoes e interfaces.
12. Documentar dependencias futuras sem fingir que ja estao implementadas.
13. Preservar isolamento absoluto em relacao a outros sistemas.

## 7. Arquitetura em camadas

A recomendacao arquitetural oficial deste projeto e:

**Monolito modular + banco central + automacoes por eventos + integracoes desacopladas**

Isso significa:

- uma unica aplicacao principal organiza a regra de negocio
- o banco interno do Yes Hotel centraliza o estado operacional
- automacoes sao disparadas por eventos internos e jobs agendados
- integracoes externas entram como adaptadores desacoplados, nunca como centro da logica

As quatro grandes camadas do sistema sao:

1. Nucleo operacional do hotel
2. Integracoes externas
3. Motor de automacao, jobs e eventos
4. Interfaces operacionais

### 7.1 Papel de cada camada

**Camada 1 - Nucleo operacional do hotel**

- concentra a regra de negocio principal
- define o estado oficial das reservas, acessos, alertas e operacao
- decide quando gerar a credencial de acesso da reserva, quando abrir alerta e quando enviar comunicacao

**Camada 2 - Integracoes externas**

- conecta o sistema com Hits, TTLock, canais de mensagem e LPR futuro
- recebe eventos externos e envia comandos externos
- devolve respostas e confirmacoes ao nucleo

**Camada 3 - Motor de automacao, jobs e eventos**

- transforma mudancas de estado interno em acoes automatizadas
- executa agendamentos, retries e reprocessamentos
- audita execucoes operacionais minimas

**Camada 4 - Interfaces operacionais**

- permite que operadores acompanhem excecoes e atuem rapidamente
- expoe informacoes necessarias sem excesso de complexidade visual
- privilegia usabilidade em celular e desktop

### 7.2 Supabase como centro

O Supabase e a base principal recomendada para a plataforma do Yes Hotel, com uso potencial para:

- PostgreSQL
- autenticacao de usuarios internos, se necessario
- storage de documentos, se necessario
- funcoes de backend quando fizer sentido
- filas simples baseadas em banco
- logs operacionais
- triggers e jobs com uso controlado

Diretriz importante:

- o banco guarda estado
- o backend executa a regra
- as automacoes processam eventos

Nao concentrar toda a logica do sistema em triggers de banco. Triggers em excesso tendem a dificultar rastreabilidade, manutencao e reprocessamento.

### 7.3 Backend modular recomendado

A implementacao deve ser organizada por dominios, evitando um backend monolitico desordenado.

Dominios principais recomendados:

- reservas
- hospedes e FNRH
- acessos
- comunicacao
- pagamentos
- placas e veiculos
- cafe da manha
- alertas
- integracoes

Essa divisao e importante para impedir acoplamento excessivo e evitar que o sistema se torne um conjunto de regras espalhadas sem fronteiras claras.

## 8. Nucleo operacional

O nucleo operacional controla os objetos centrais do hotel:

- reservas
- hospedes
- contatos
- FNRH e check-in digital
- apartamentos
- blocos
- portoes
- fechaduras
- credenciais de acesso e suas senhas operacionais
- eventos de acesso
- pagamento operacional
- placas autorizadas
- presenca no cafe da manha
- alertas operacionais
- historico de comunicacao

### 8.1 Responsabilidades do nucleo

O nucleo operacional deve:

- consolidar a reserva como entidade operacional principal
- definir em qual apartamento e bloco a reserva esta alocada
- decidir quando existe ou nao dependencia de FNRH para gerar a credencial de acesso da reserva
- manter o status operacional de pagamento
- registrar a credencial de acesso principal da reserva
- registrar o provisionamento fisico dessa credencial nas fechaduras aplicaveis
- registrar eventos de acesso recebidos da TTLock
- abrir e encerrar alertas operacionais
- manter historico das mensagens enviadas
- manter o estado operacional que sera exibido nos paineis

### 8.2 Regra central de fonte da verdade

Mesmo quando um dado vier de fora, o estado oficial usado pelo sistema deve ser o estado consolidado internamente no banco do Yes Hotel.

Exemplos:

- o Hits informa a reserva, mas a reserva operacional consolidada pertence ao nucleo interno
- a TTLock materializa a credencial em fechaduras e envia eventos, mas a decisao sobre a credencial da reserva pertence ao nucleo interno
- WhatsApp e email entregam mensagens, mas o historico operacional pertence ao nucleo interno

### 8.3 Reserva como entidade central

A reserva e a entidade operacional central do sistema.

Tudo gira em torno dela, e nao em torno do hospede isolado ou da fechadura isolada.

A reserva funciona como pivo de ligacao entre:

- apartamento
- hospedes
- FNRH
- acesso
- pagamento
- comunicacao
- cafe da manha
- placa de veiculo
- alertas

Essa decisao deve orientar modelagem, contratos de integracao, telas e automacoes.

## 9. Integracoes externas

As integracoes externas previstas sao:

- Hits PMS
- TTLock
- email
- WhatsApp Business
- LPR e cameras, em etapa futura

### 9.1 Hits PMS

Papel:

- fonte externa de reserva
- origem de entrada e atualizacao de dados de hospedagem

Limites:

- nao define a regra principal do sistema
- nao substitui o estado operacional interno

### 9.2 TTLock

Papel:

- executor do provisionamento fisico da credencial nas fechaduras
- origem de eventos fisicos de acesso

Limites:

- nao define a regra de negocio da credencial
- nao determina sozinho o significado operacional do acesso

### 9.3 Email e WhatsApp Business

Papel:

- canais de comunicacao com o hospede
- entrega de link de check-in, lembretes, senha correspondente a credencial e orientacoes

Limites:

- canais de envio, nao fonte de verdade
- o sistema deve guardar historico interno do que tentou enviar, quando enviou e qual foi o resultado

### 9.4 LPR e cameras

Papel:

- integracao futura para acesso veicular automatico
- leitura de placa e validacao contra reserva ativa

Limites:

- dependencia futura de definicao tecnica
- nao assumir implementacao pronta nesta etapa

### 9.5 Webhooks de entrada

O sistema deve prever endpoints ou mecanismos equivalentes de entrada para:

- reservas vindas do Hits
- eventos da TTLock
- eventos do LPR
- confirmacoes de entrega de mensagem, quando existirem

Esses pontos de entrada devem:

- validar a origem
- registrar o recebimento
- traduzir o payload externo
- gerar evento interno correspondente
- suportar tratamento idempotente

## 10. Motor de automacao / eventos / jobs

O sistema deve operar prioritariamente por eventos internos.

Eventos internos importantes a documentar:

- reserva recebida
- reserva alterada
- FNRH enviado
- FNRH preenchido
- credencial de acesso gerada
- credencial de acesso provisionada
- senha da credencial enviada
- mensagem enviada
- primeiro acesso detectado
- pagamento confirmado
- pagamento pendente detectado
- alerta aberto
- alerta encerrado
- placa cadastrada
- placa reconhecida
- presenca no cafe registrada
- checkout concluido

### 10.1 Separacao entre estado e evento

O sistema deve separar com clareza estado operacional e evento operacional.

Exemplos de estado:

- reserva confirmada
- FNRH pendente
- pagamento pendente
- credencial de acesso gerada

Exemplos de evento:

- reserva criada
- ficha enviada
- ficha preenchida
- acesso detectado
- alerta aberto

Misturar estado com evento aumenta complexidade e dificulta automacao, auditoria e reprocessamento.

### 10.2 Reprocessamento

Toda automacao importante deve ser reprocessavel.

Isso significa que o sistema deve suportar:

- repeticao segura de processamentos em caso de falha
- retries de envio
- retentativa de provisionamento da credencial de acesso
- reavaliacao de alertas
- execucao posterior de jobs agendados que nao rodaram no horario correto
- tratamento idempotente de webhooks e eventos duplicados

### 10.3 Jobs agendados obrigatorios

Os jobs devem suportar, no minimo:

- envio do link de FNRH no momento da reserva
- envio do link de FNRH 24 horas antes do check-in
- envio do link de FNRH as 07:00 do dia do check-in
- verificacao de falhas e retries
- fechamento ou reavaliacao de alertas quando aplicavel
- montagem da lista operacional do cafe do dia
- auditoria minima operacional da execucao

### 10.4 Tratamento de falhas

O motor de automacao deve registrar:

- o que foi tentado
- quando foi tentado
- qual foi o resultado
- qual erro ocorreu, se houver
- se existe nova tentativa agendada

### 10.5 Motor minimo de jobs recomendado

Para a fase inicial, a arquitetura deve prever um motor de jobs simples e operacional, baseado em:

- tabela de jobs
- cron disparando processador
- status como pendente, executando, concluido e erro

Essa abordagem e preferivel a espalhar crons avulsos sem rastreabilidade central.

## 11. Interfaces operacionais

As interfaces devem ser responsivas, com uso pratico em desktop e celular, baixa complexidade visual e foco em acao rapida.

As interfaces minimas previstas sao:

1. Painel operacional de excecoes
2. Painel administrativo
3. Painel de reservas e hospedes
4. Painel de cafe da manha
5. Tela manual de cadastro de placa
6. Eventual tela de override operacional

### 11.1 Painel operacional de excecoes

Esse painel deve mostrar somente problemas e excecoes operacionais.

Exemplos:

- hospede entrou sem FNRH
- hospede ainda nao acessou o apartamento
- hospede entrou sem pagamento
- falha na geracao da credencial de acesso
- falha no envio de mensagem
- divergencia de acesso
- placa rejeitada ou nao reconhecida quando deveria estar autorizada

Este painel nao e um painel de tudo. Ele e um painel de intervencao.

### 11.2 Painel administrativo

Pode consolidar visoes de consulta e apoio para usuarios internos com perfil administrativo, desde que permaneca subordinado ao foco operacional do sistema e nao amplie o escopo para um painel gerencial abrangente.

### 11.3 Painel de reservas e hospedes

Deve permitir:

- consultar reserva
- visualizar hospedes vinculados
- visualizar status de FNRH
- visualizar status de pagamento operacional
- visualizar a credencial de acesso da reserva, a senha correspondente e seu estado de provisionamento
- visualizar historico de mensagens
- visualizar alertas da reserva

### 11.4 Painel de cafe da manha

Deve ser simples e operacional.

Exemplo de lista:

- Apto 18 - 3 hospedes
- Apto 35 - 1 hospede

O funcionario deve poder marcar presenca, e o sistema deve calcular:

- quantos hospedes ja vieram
- quantos ainda faltam

### 11.5 Tela manual de cadastro de placa

Deve permitir:

- cadastrar placa vinculada a reserva ativa
- editar placa quando necessario
- registrar autoria operacional da acao

### 11.6 Override operacional

Pode existir futuramente uma tela de override para:

- apoio manual em excecoes
- ajuste operacional controlado
- reenvio de comunicacao
- reprocessamento de automacoes

Detalhes de permissao e comportamento refinado ficam para definicao posterior.

## 12. Modelo conceitual de dados

Este modelo e conceitual. Nao representa SQL final, nem schema definitivo.

### 12.1 Estrutura fisica

**blocos**

- representam os dois blocos fisicos do hotel
- agrupam apartamentos e definem o portao correspondente

**apartamentos**

- representam as unidades de hospedagem
- pertencem a um bloco
- possuem uma fechadura TTLock propria

**portoes**

- representam os acessos principais dos blocos
- pertencem a um bloco
- possuem duas fechaduras TTLock vinculadas, externo e interno

**fechaduras**

- representam os dispositivos fisicos TTLock
- podem estar vinculadas a apartamento ou portao
- armazenam identidade logica suficiente para provisionamento e auditoria operacional

### 12.2 Operacao

**reservas**

- entidade operacional principal da hospedagem
- referencia apartamento, bloco, periodo e status operacionais
- deve ser tratada como pivo das demais relacoes operacionais

**hospedes**

- pessoas vinculadas a uma ou mais reservas

**reserva_hospedes**

- relacao entre reserva e hospedes
- permite um ou mais hospedes por reserva

**checkins_digitais**

- representa o processo de pre check-in e FNRH
- registra convites, preenchimento, status e pendencias
- deve suportar, no minimo em nivel conceitual, os estados: nao iniciado, enviado, preenchido e pendente apos chegada

**acessos_senhas**

- representa a credencial de acesso principal da reserva
- deve refletir uma unica credencial de acesso por hospedagem/reserva
- a senha entregue ao hospede e a materializacao dessa credencial para uso operacional
- registra o estado da credencial principal
- registra ou referencia o provisionamento fisico dessa mesma credencial em multiplas fechaduras fisicas
- deve ser compativel com expiracao, revogacao ou reprogramacao em caso de cancelamento, alteracao de reserva, no-show ou fim da hospedagem

**acessos_eventos**

- registra eventos de acesso fisico recebidos das fechaduras
- inclui deteccao de primeiro acesso e demais ocorrencias relevantes
- deve diferenciar, sempre que tecnicamente possivel, eventos de apartamento e eventos de portao

**pagamentos_operacionais**

- registra o status operacional de pagamento da reserva
- nao representa modulo financeiro completo
- deve suportar, no minimo em nivel conceitual, os estados: pendente, confirmado, dispensado e indefinido

**mensagens**

- registra tentativas e resultados de comunicacao por email ou WhatsApp

**jobs_automacao**

- registra execucoes, falhas, retries e reprocessamentos de automacoes
- pode sustentar um motor minimo de processamento assincrono orientado por status

**alertas_operacionais**

- registra excecoes abertas, status, prioridade e resolucao operacional

### 12.3 Veiculos

**placas_autorizadas**

- registra placas vinculadas a reservas ativas
- pode ter origem no FNRH ou em cadastro manual por operador

**eventos_lpr**

- registra leituras de placa e seus resultados operacionais
- depende de integracao futura com LPR

### 12.4 Cafe da manha

**cafe_presencas**

- registra presenca operacional do cafe inicialmente de forma simples, baseada em data, reserva, apartamento, quantidade esperada e quantidade presente
- nao exige individualizacao obrigatoria por hospede nesta fase

### 12.5 Usuarios internos

**usuarios_internos**

- representam operadores e usuarios administrativos do sistema
- podem ser usados para autoria, override e rastreabilidade operacional

## 13. Relacoes conceituais

Relacoes conceituais minimas:

- bloco possui apartamentos
- bloco possui portao
- portao possui duas fechaduras
- apartamento possui uma fechadura
- reserva pertence a um apartamento
- reserva herda o bloco a partir do apartamento
- reserva possui um ou mais hospedes
- reserva possui um processo de check-in digital
- reserva possui uma credencial de acesso principal
- credencial e provisionada em multiplas fechaduras
- reserva possui eventos de acesso
- reserva possui mensagens
- reserva possui alertas
- reserva pode possuir placas autorizadas
- reserva participa do controle do cafe
- usuarios internos podem registrar acoes operacionais

## 14. Fluxos principais do sistema

### 14.1 Fluxo de entrada de reserva

1. A reserva entra a partir do Hits PMS.
2. O sistema consolida a reserva internamente.
3. O sistema identifica apartamento e bloco.
4. O sistema verifica disponibilidade de email e WhatsApp.
5. O sistema prepara o fluxo de pre check-in e FNRH.
6. O sistema agenda automacoes relacionadas a comunicacao e acompanhamento operacional.

### 14.2 Fluxo de envio do FNRH

1. Ao receber a reserva, o sistema tenta enviar o link de FNRH.
2. Se necessario, o sistema agenda novo envio 24 horas antes do check-in.
3. Se ainda necessario, o sistema agenda novo envio as 07:00 do dia do check-in.
4. Cada tentativa deve ser registrada no historico de mensagens e automacoes.

### 14.3 Fluxo de geracao da credencial de acesso

Regra principal:

- a reserva possui uma unica credencial de acesso principal
- essa credencial e unica por hospedagem/reserva
- a senha entregue ao hospede e a materializacao operacional dessa credencial
- essa mesma credencial deve funcionar no apartamento e nas duas fechaduras do portao do bloco correspondente

Distincao obrigatoria:

- **credencial logica da reserva**: entidade logica de acesso vinculada a reserva
- **senha da credencial**: forma apresentada ao hospede para uso operacional
- **provisionamento fisico**: replicacao da mesma credencial nas fechaduras fisicas necessarias

Fluxo para reserva com contato:

1. A reserva entra com email ou WhatsApp disponivel.
2. O sistema aguarda o preenchimento do FNRH.
3. Apos o FNRH preenchido, o sistema gera a credencial de acesso unica da reserva.
4. O sistema provisiona a mesma credencial na fechadura do apartamento.
5. O sistema provisiona a mesma credencial na fechadura externa do portao do bloco.
6. O sistema provisiona a mesma credencial na fechadura interna do portao do bloco.
7. O sistema registra o resultado do provisionamento.
8. O sistema envia ao hospede a senha correspondente a credencial.

Fluxo para reserva sem contato:

1. A reserva entra sem email e sem WhatsApp utilizaveis.
2. O sistema nao depende do FNRH para gerar a credencial.
3. O sistema gera a credencial unica automaticamente.
4. O sistema provisiona a mesma credencial nas fechaduras necessarias.
5. O sistema registra a ausencia de contato e eventual pendencia operacional relacionada ao FNRH.

Diretriz minima de ciclo de vida:

- a credencial de acesso da reserva deve ser compativel com expiracao, revogacao ou reprogramacao em caso de cancelamento, alteracao de reserva, no-show ou fim da hospedagem

### 14.4 Fluxo de primeiro acesso

1. A TTLock envia ou disponibiliza evento de acesso.
2. O sistema registra o evento internamente.
3. O sistema identifica se aquele e o primeiro evento valido de acesso da reserva.
4. A chegada real deve ser caracterizada preferencialmente pelo primeiro evento valido na fechadura do apartamento.
5. Eventos de portao podem ser registrados e analisados, mas nao devem, por padrao, substituir a chegada real ao apartamento sem regra tecnica explicita.
6. Se a integracao nao permitir essa distincao com seguranca, o sistema deve adotar fallback controlado e documentado.
7. Se o evento adotado como primeiro acesso caracterizar a chegada real, o sistema reavalia pendencias de FNRH, pagamento e alertas operacionais.

### 14.5 Fluxo de excecao por falta de FNRH

1. O hospede acessa o apartamento sem FNRH preenchido.
2. O sistema detecta o primeiro acesso.
3. O sistema envia mensagem automatica:
   "Seja bem vindo ao Yes Hotel. Notamos que sua ficha de check-in ainda nao foi preenchida."
4. O sistema complementa com aviso:
   "Se nao for preenchido em 1 hora, a energia do apartamento podera ser desligada."
5. O sistema abre ou mantem alerta operacional correspondente.
6. A possibilidade de bloqueio ou corte de energia permanece apenas como dependencia futura de definicao tecnica.

### 14.6 Fluxo de excecao por falta de pagamento

1. O sistema detecta primeiro acesso ou outra evidencia operacional relevante.
2. O sistema verifica o status operacional de pagamento da reserva.
3. Se nao houver pagamento registrado, o sistema abre alerta interno.
4. O alerta pode aparecer no painel operacional e em email interno.

Mensagem de referencia:

- "Reserva acessou apartamento sem pagamento registrado."

### 14.7 Fluxo de placa / LPR

1. O hospede informa a placa durante o FNRH, quando aplicavel.
2. Alternativamente, um operador cadastra a placa manualmente.
3. O sistema registra a placa autorizada vinculada a reserva ativa.
4. Em integracao futura, a camera LPR reconhece a placa.
5. O sistema valida se existe reserva ativa autorizando aquele acesso.
6. Em caso positivo, o sistema pode disparar a abertura do portao.
7. O sistema registra o evento de leitura e o resultado operacional.

### 14.8 Fluxo de cafe da manha

1. O sistema monta a lista operacional por apartamento e quantidade de hospedes esperados.
2. O funcionario registra a presenca.
3. O sistema calcula quantos ja compareceram.
4. O sistema calcula quantos ainda faltam.

## 15. Regras operacionais criticas

As regras operacionais criticas consolidadas neste documento sao:

- o projeto e exclusivo do Yes Hotel
- nao pode haver mistura com Meta Lav Auditorias
- nao pode haver mistura com Nexus Pagamentos
- o sistema deve usar ambiente Supabase proprio e exclusivo
- o banco interno do Yes Hotel e a fonte da verdade
- Hits, TTLock, email, WhatsApp e LPR sao integracoes desacopladas
- a reserva possui uma unica credencial de acesso principal por hospedagem
- a senha entregue ao hospede materializa essa credencial para uso operacional
- a mesma credencial deve abrir o apartamento e os dois pontos de acesso do portao do bloco correspondente
- deve existir distincao entre credencial logica da reserva e provisionamento fisico nas fechaduras
- se houver contato, a credencial deve ser gerada apos FNRH preenchido
- se nao houver contato, a credencial deve ser gerada automaticamente mesmo sem FNRH
- o primeiro acesso deve ser registrado para validar a chegada real, preferencialmente a partir da fechadura do apartamento
- entrada sem FNRH deve gerar comunicacao automatica e alerta operacional
- entrada sem pagamento deve gerar alerta interno
- o painel principal deve ser focado em excecoes, nao em exibicao total da operacao
- o modulo de cafe da manha deve ser simples e operacional
- o sistema deve separar claramente estado operacional e evento operacional
- webhooks e eventos externos devem ser tratados com idempotencia
- a logica de negocio nao deve ficar espalhada em triggers de banco ou conectores externos

## 16. Decisoes arquiteturais ja definidas

As seguintes decisoes ja estao tomadas:

- projeto exclusivo do Yes Hotel
- separacao total de Meta Lav Auditorias e Nexus Pagamentos
- Supabase em ambiente proprio e exclusivo
- arquitetura em monolito modular
- banco interno como fonte da verdade
- uso de integracoes desacopladas
- painel focado em excecoes
- cafe da manha com painel simples
- pagamento tratado como status operacional, e nao como modulo financeiro complexo neste momento
- uma unica credencial de acesso por reserva/hospedagem
- senha correspondente a mesma credencial valida para apartamento e portoes do bloco
- distincao entre credencial logica e provisionamento fisico nas fechaduras
- reserva como entidade central do sistema
- separacao entre estado e evento
- backend organizado por dominios
- motor minimo de jobs centralizado, em vez de automacoes avulsas sem controle

## 17. Riscos e pontos que dependem de definicao futura

Pontos explicitamente marcados como "a definir depois":

- detalhes tecnicos da integracao concreta com Hits
- detalhes tecnicos concretos da API TTLock
- definicao do provedor de WhatsApp
- implementacao fisica de corte de energia
- detalhamento tecnico do LPR e das cameras
- politicas finais de cancelamento e revogacao da credencial de acesso
- eventual politica refinada de expiracao de acesso
- eventual integracao com pagamentos reais

Riscos arquiteturais a acompanhar:

- dependencia de qualidade dos dados vindos do Hits
- dependencia de confiabilidade operacional da TTLock
- necessidade de reprocessamento consistente em falhas de integracao
- necessidade de rastreabilidade minima para automacoes e alertas
- risco de concentrar logica demais em triggers de banco
- risco de acoplamento excessivo se conectores externos passarem a decidir regras de negocio

## 18. Proximos passos recomendados

Os proximos passos recomendados, somente apos validacao deste documento, sao:

1. Validar a arquitetura funcional e operacional aqui consolidada.
2. Confirmar os estados operacionais minimos de reserva, FNRH, pagamento e alerta.
3. Detalhar o modelo conceitual em schema logico sem ainda implementar SQL definitivo.
4. Definir contratos de integracao para Hits, TTLock, canais de mensagem e LPR futuro.
5. Mapear eventos internos e jobs necessarios.
6. Desenhar as primeiras interfaces operacionais com foco em excecoes e uso mobile.
7. Definir os webhooks de entrada para Hits, TTLock, LPR e confirmacoes de entrega de mensagem, quando existirem.
8. Escolher a forma do backend entre Edge Functions pontuais e backend modular separado, mantendo o Supabase como centro de dados.

---

## Status deste documento

Este arquivo e a fonte da verdade arquitetural inicial do projeto Yes Hotel.

Nenhum schema SQL, migration, endpoint, automacao ou interface deve ser definido sem coerencia com este documento.

## Glossario minimo

**Reserva**

- entidade operacional central que conecta hospedagem, apartamento, hospedes, FNRH, acesso, pagamento, placas, cafe e alertas

**Credencial de acesso da reserva**

- entidade logica principal de acesso vinculada a uma reserva/hospedagem

**Senha da credencial**

- forma operacional apresentada ao hospede para utilizar a credencial de acesso da reserva

**Provisionamento fisico**

- aplicacao da mesma credencial de acesso nas fechaduras fisicas necessarias, como apartamento e portoes do bloco

**Primeiro acesso**

- primeiro evento valido adotado para caracterizar a chegada real, preferencialmente na fechadura do apartamento

**Painel operacional de excecoes**

- tela principal de intervencao humana, focada somente em desvios, falhas e pendencias operacionais
