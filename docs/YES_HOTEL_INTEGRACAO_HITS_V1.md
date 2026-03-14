# YES HOTEL - Integracao HITS V1

## 1. Objetivo da integracao HITS

Este documento define a fonte da verdade funcional da integracao entre o Yes Hotel e o HITS no contexto da operacao do hotel.

O objetivo da integracao e permitir que o Yes consuma e sincronize as informacoes necessarias de hospedagem para automatizar:

- entrada e atualizacao de reservas
- definicao de apartamento e bloco operacional
- disparo de FNRH e comunicacoes
- geracao, revogacao e reprovisionamento de credenciais
- abertura de alertas e acompanhamento de excecoes

Diretriz central desta integracao:

- HITS controla hospedagem
- Yes controla credencial
- TTLock executa acesso

Isso significa que o HITS e a fonte oficial externa da hospedagem, enquanto o Yes consolida internamente o estado operacional necessario para executar automacoes, credenciais, comunicacao e tratamento de excecoes.

## 2. Papel do HITS no sistema Yes Hotel

O papel funcional do HITS no ecossistema do Yes Hotel e:

- HITS e a fonte oficial de reservas
- HITS e a fonte oficial do apartamento da reserva
- HITS e a fonte oficial das datas previstas de hospedagem
- HITS e a fonte oficial do status da hospedagem
- HITS e a fonte oficial de troca de apartamento
- HITS nao gera a senha da fechadura no modelo do Yes Hotel
- HITS nao fala diretamente com a TTLock no modelo operacional do Yes Hotel

Desdobramento funcional:

- reserva, apartamento, datas e troca de quarto devem vir do HITS
- a senha inicial da credencial e gerada automaticamente pelo sistema Yes
- essa credencial nasce por decisao do Yes, mas em resposta ao contexto de hospedagem controlado pelo HITS
- early check-in e late check-out sao ajustes manuais dentro do sistema Yes
- troca de apartamento deve sempre refletir o que vier do HITS
- mudancas relevantes de hospedagem devem provocar reavaliacao da credencial
- o app da TTLock nao deve ser usado como fluxo padrao de geracao manual de credenciais

## 3. Dados minimos que o Yes precisa receber ou sincronizar do HITS

Os dados conceituais minimos que o Yes precisa consumir do HITS sao:

- identificador externo da reserva
- origem da reserva
- hospede principal
- contatos disponiveis, como email e WhatsApp
- apartamento atual da reserva
- data de check-in prevista
- data de check-out prevista
- status da reserva ou hospedagem
- quantidade de hospedes, se disponivel
- observacoes relevantes, se existirem

Dados desejaveis adicionais, se existirem de forma confiavel no HITS:

- indicacao de alteracao recente
- momento de criacao ou atualizacao do registro
- indicacao de cancelamento
- indicacao de check-in real
- indicacao de check-out real

Este documento nao define payload final, naming tecnico de campos nem estrutura exata de resposta. Esses pontos dependem de confirmacao na API real do HITS.

## 4. Eventos operacionais relevantes vindos do HITS

Os eventos operacionais relevantes para o Yes sao:

- reserva criada
- reserva alterada
- apartamento alterado
- reserva cancelada
- check-in confirmado, se existir no HITS
- check-out ou encerramento, se existir no HITS

Interpretacao funcional desses eventos:

- `reserva criada` inicia o processo de consolidacao interna no Yes
- `reserva alterada` exige comparacao contra o estado interno atual
- `apartamento alterado` exige tratamento prioritario por impactar acesso fisico
- `reserva cancelada` exige revogacao ou encerramento de jornada operacional
- `check-in confirmado` pode reforcar ou antecipar estados operacionais, se o HITS oferecer esse conceito com confiabilidade
- `check-out ou encerramento` deve levar ao encerramento operacional da hospedagem e da credencial

## 5. Estrategia de sincronizacao recomendada

Este documento reconhece dois cenarios possiveis de integracao.

### 5.1 Cenario ideal

- HITS fornece API adequada para consulta
- HITS fornece webhooks ou mecanismo equivalente de notificacao
- o Yes recebe mudancas relevantes com baixa latencia

### 5.2 Cenario pratico aceitavel

- o Yes faz sincronizacao periodica
- o Yes compara o estado recebido com o estado consolidado internamente
- mudancas relevantes geram eventos internos e tratamento operacional

### 5.3 Recomendacao inicial

A recomendacao inicial para o projeto e:

- adotar sincronizacao periodica segura e rastreavel
- tratar webhooks como melhoria potencial, nao como dependencia inicial obrigatoria
- evitar depender exclusivamente de webhooks antes da confirmacao da API real do HITS
- garantir idempotencia na entrada e no reprocessamento
- registrar o que foi sincronizado, quando foi sincronizado e qual diferenca foi encontrada

Objetivo operacional da estrategia:

- reduzir dependencia de comportamento nao confirmado da API
- manter previsibilidade de operacao
- permitir reconciliacao segura em caso de falha, atraso ou indisponibilidade do HITS

## 6. Regras de deteccao de mudanca

O Yes deve comparar internamente, por reserva:

- apartamento atual
- datas previstas de hospedagem
- status da hospedagem
- disponibilidade de contato

Mudancas que devem ser detectadas funcionalmente:

- apartamento mudou
- check-in previsto mudou
- check-out previsto mudou
- reserva foi cancelada
- reserva foi encerrada
- contato passou a existir
- contato deixou de existir

Diretriz de comparacao:

- o HITS informa a mudanca externa
- o Yes compara com seu estado consolidado interno
- a diferenca encontrada gera impacto operacional, evento interno, job ou alerta conforme o caso

Prioridade operacional de mudancas:

- alta prioridade: apartamento alterado, cancelamento, encerramento
- media prioridade: mudanca de datas previstas
- prioridade operacional relevante: ganho ou perda de contato para comunicacao

## 7. Regras de impacto em credenciais TTLock

As regras funcionais congeladas para credenciais sao as seguintes.

### 7.1 Reserva nova apta a automacao

- uma reserva nova pode gerar credencial conforme a politica ja definida do projeto
- se houver contato disponivel, a geracao segue a dependencia de FNRH prevista na arquitetura congelada
- se nao houver contato utilizavel, o Yes pode gerar a credencial automaticamente conforme a politica ja definida
- a senha inicial e gerada automaticamente pelo Yes
- essa geracao ocorre por contexto operacional originado da hospedagem controlada pelo HITS

### 7.2 Apartamento mudou no HITS

- a mudanca de apartamento recebida do HITS deve ser tratada como mudanca relevante de hospedagem
- o Yes deve revogar ou reprogramar a credencial antiga conforme a politica operacional aplicavel
- o Yes deve remover o acesso do apartamento anterior
- o Yes deve provisionar a credencial no novo apartamento
- se a troca implicar mudanca de bloco, o Yes deve ajustar tambem os acessos de portao correspondentes
- se a mudanca ainda nao estiver refletida nas fechaduras, isso deve ser tratavel como excecao operacional

### 7.3 Datas mudaram

- o Yes deve reavaliar a validade da credencial
- o Yes deve revogar, reprogramar ou ajustar a janela de acesso conforme necessario
- early check-in e late check-out feitos manualmente no Yes devem ser tratados como ajuste operacional controlado, sem reescrever a origem oficial da hospedagem vinda do HITS

### 7.4 Reserva cancelada

- a credencial deve ser revogada
- o provisionamento fisico deve ser tratado conforme a politica de revogacao do sistema
- a reserva cancelada nao deve continuar com acesso operacional ativo

### 7.5 Reserva encerrada

- a credencial deve estar expirada ou ser revogada conforme a politica operacional em vigor
- a hospedagem encerrada nao deve permanecer com acesso operacional valido

### 7.6 Diretriz geral

- o Yes decide a regra de credencial
- a TTLock apenas executa provisionamento e entrega eventos
- o HITS nao substitui a logica interna de credencial do Yes

## 8. Regras de impacto em FNRH e mensagens

Quando o HITS informar dados suficientes de reserva e contato:

- o Yes deve disparar o fluxo de FNRH
- o Yes deve agendar ou reagendar mensagens conforme as datas previstas vigentes
- o Yes deve ajustar a jornada de comunicacao quando a reserva mudar de status
- o Yes deve tratar a ausencia ou presenca de contato como condicao operacional relevante

Impactos funcionais esperados:

- reserva nova com contato: tentativa de envio do link de FNRH
- mudanca de datas: reavaliacao dos agendamentos de mensagem
- cancelamento: encerramento ou bloqueio da jornada de mensagens aplicavel
- encerramento: nao manter comunicacao operacional que dependa de hospedagem ativa
- ganho posterior de contato: reavaliar se o fluxo de FNRH e comunicacao deve ser retomado
- perda posterior de contato: registrar a limitacao e tratar como condicao operacional de excecao, quando relevante

## 9. Regras de impacto no painel operacional

O painel operacional deve refletir divergencias relevantes entre hospedagem controlada pelo HITS e estado operacional consolidado pelo Yes.

Exemplos de alertas ou pendencias operacionais:

- reserva sem apartamento definido
- mudanca de apartamento ainda nao refletida na credencial
- cancelamento recebido sem revogacao confirmada da credencial
- ausencia de contato em reserva que exige comunicacao
- divergencia entre estado da reserva e estado da credencial
- falha de sincronizacao do HITS com impacto operacional

Diretriz de painel:

- o painel principal continua sendo de excecoes
- o objetivo nao e espelhar tudo que o HITS possui
- o objetivo e destacar o que exige intervencao, verificacao ou reprocessamento

## 10. Excecoes e divergencias possiveis

As excecoes e divergencias operacionais mais relevantes desta integracao sao:

- HITS atrasado ou indisponivel
- reserva alterada no HITS e ainda nao sincronizada no Yes
- credencial provisionada para quarto antigo
- dados de contato ausentes
- status ambiguo da reserva ou hospedagem
- diferenca entre a hospedagem registrada no HITS e o uso real detectado pela TTLock
- troca de apartamento recebida em momento critico, com credencial ja ativa
- reserva cancelada no HITS com acesso ainda fisicamente valido

Tratamento esperado em alto nivel:

- registrar a divergencia
- reprocessar a sincronizacao quando possivel
- abrir alerta operacional quando houver risco de acesso incorreto, comunicacao falha ou inconsistencia relevante de hospedagem

## 11. Pontos que dependem da API real do HITS

Os pontos abaixo dependem de confirmacao no Swagger ou API real do HITS:

- nome exato dos endpoints
- modelo de autenticacao
- existencia e formato de paginacao
- existencia ou nao de webhooks
- como o HITS representa mudanca de apartamento
- como o HITS representa cancelamento
- como o HITS representa check-in real
- como o HITS representa check-out real
- frequencia segura e custo operacional da sincronizacao
- existencia de campos de ultima alteracao confiaveis
- capacidade de filtrar por periodo, status ou atualizacao recente

Todos esses pontos devem ser tratados como:

- a confirmar no Swagger/API real

## 12. Proximos passos da integracao

A sequencia recomendada para a integracao HITS e:

1. Abrir o Swagger/API real do HITS.
2. Mapear os endpoints reais disponiveis.
3. Definir o contrato tecnico HITS -> Yes.
4. Definir a rotina de sincronizacao inicial.
5. Definir a rotina de reconciliacao e reprocessamento.
6. So depois partir para implementacao.

## 13. Resumo funcional consolidado

Resumo das responsabilidades no ecossistema:

- HITS controla hospedagem
- Yes controla credencial
- TTLock executa acesso

Resumo das diretrizes principais:

- o HITS informa a hospedagem oficial
- o Yes consolida o estado operacional interno
- mudancas de reserva, apartamento, data e status devem impactar credenciais e comunicacao
- troca de apartamento vinda do HITS sempre prevalece como evento de hospedagem
- a credencial nao deve ser gerada manualmente no app da TTLock como fluxo padrao
- pontos tecnicos nao confirmados devem permanecer marcados como dependentes do Swagger/API real
