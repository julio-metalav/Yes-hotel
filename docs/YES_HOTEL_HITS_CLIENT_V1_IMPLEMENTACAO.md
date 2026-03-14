# Yes Hotel - HITS Client V1 Implementacao

## Objetivo

Documentar a base minima criada para testes controlados da integracao com a API HITS, sem banco, sem rotas HTTP e sem qualquer fluxo de producao.

## Arquivos criados

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `.env.example`
- `src/lib/integrations/hits/types.ts`
- `src/lib/integrations/hits/env.ts`
- `src/lib/integrations/hits/client.ts`
- `src/lib/integrations/hits/preview.ts`
- `src/lib/integrations/hits/index.ts`
- `scripts/_shared.ts`
- `scripts/test-hits-auth.ts`
- `scripts/test-hits-reservations.ts`
- `scripts/test-hits-reservation-detail.ts`

## Envs necessarias

- `HITS_BASE_URL`
- `HITS_API_VERSION`
- `HITS_ACCESS_SECRET`
- `HITS_TENANT_NAME`
- `HITS_PROPERTY_CODE`
- `HITS_PARTNER_USER_ID`
- `HITS_CLIENT_ID`
- `HITS_LANGUAGE_CODE`

Observacao:

- para o primeiro teste de `POST /Authorize`, as envs estritamente necessarias sao `HITS_BASE_URL`, `HITS_API_VERSION` e `HITS_ACCESS_SECRET`
- as demais passam a ser obrigatorias nas chamadas autenticadas posteriores de listagem e detalhe

## O que foi implementado

### Cliente HITS

O cliente em `src/lib/integrations/hits/client.ts` implementa:

- `authorizeHits()`
- `listReservations(params)`
- `getReservationById(id)`

O modulo tambem faz:

- leitura e validacao das envs obrigatorias
- validacao separada entre auth inicial e headers obrigatorios do pos-auth
- montagem de headers confirmados no material tecnico atual
- timeout basico por requisicao
- tratamento de erro com contexto de metodo e endpoint
- mascara de token para debug seguro

## Tipagem minima

O arquivo `src/lib/integrations/hits/types.ts` contem interfaces minimas e honestas para:

- resposta de autenticacao
- item de listagem de reservas
- detalhe da reserva
- quarto da reserva
- hospede da reserva
- preview interno simplificado

## Preview interno

O arquivo `src/lib/integrations/hits/preview.ts` implementa `mapHitsReservationDetailToInternalPreview(...)`, retornando:

- `reservationId`
- `guestMainName`
- `guestMainEmail`
- `guestMainPhone`
- `roomId`
- `roomCode`
- `checkIn`
- `checkOut`
- `updatedAt`

## Scripts de teste manual

### Autenticacao

```bash
npm run test:hits:auth
```

Executa `POST /Authorize` e exibe a resposta com token mascarado.

### Listagem de reservas

```bash
npm run test:hits:reservations -- --type 2 --status 1 --initial-date 2026-03-01 --final-date 2026-03-31 --page 1 --size 20
```

Parametros aceitos:

- `--type`
- `--status`
- `--initial-date`
- `--final-date`
- `--reservation-integration-id`
- `--page`
- `--size`

### Detalhe de reserva

```bash
npm run test:hits:reservation -- --id <RESERVATION_ID>
```

Busca a reserva no endpoint de detalhe e imprime:

- preview interno minimo
- resposta bruta completa

## Limitacoes atuais

- nao ha persistencia em banco
- nao ha sincronizacao automatica
- nao ha qualquer integracao com TTLock
- nao ha FNRH, mensagens ou painel
- o corpo exato do `POST /Authorize` ainda deve ser confirmado no teste autenticado real; o cliente foi preparado com leitura tecnica inicial baseada em `accessSecret`
- o uso do header `Authorization: Bearer <token>` tambem deve ser confirmado na chamada real

## Proximos passos

1. preencher `.env` local com credenciais reais
2. validar autenticacao real
3. validar listagem de reservas
4. validar detalhe da reserva
5. confirmar payload real de autenticacao e formato exato do token
6. so depois discutir prova de conceito de sincronizacao
