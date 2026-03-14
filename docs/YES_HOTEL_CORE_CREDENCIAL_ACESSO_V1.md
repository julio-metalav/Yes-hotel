# Yes Hotel - Core Credencial e Acesso V1

## Objetivo da entrega

Implementar o nucleo operacional interno de credencial e acesso do Yes Hotel com dados mockados e simulacao local, sem banco, sem HITS real, sem TTLock real e sem rotas HTTP.

## Arquivos criados

- `src/lib/domain/yes-hotel/types.ts`
- `src/lib/domain/yes-hotel/hotel-layout.ts`
- `src/lib/domain/yes-hotel/credential-preview.ts`
- `src/lib/domain/yes-hotel/access-engine.ts`
- `src/lib/domain/yes-hotel/index.ts`
- `scripts/_yes-hotel-mocks.ts`
- `scripts/test-yes-access-normal.ts`
- `scripts/test-yes-access-early-checkin.ts`
- `scripts/test-yes-access-late-checkout.ts`
- `scripts/test-yes-access-room-change.ts`
- `scripts/test-yes-access-cancel.ts`

## Regras implementadas

- reserva como entidade central do fluxo
- janela padrao de credencial com check-in as 13:00
- janela padrao de credencial com check-out as 11:00
- ajuste manual de early check-in
- ajuste manual de late check-out
- resolucao de bloco pelo apartamento
- resolucao dos tres acessos operacionais por reserva:
  - fechadura do apartamento
  - portao externo do bloco
  - portao interno do bloco
- plano inicial de provisionamento
- plano de cancelamento com revogacao
- plano de troca de apartamento com revogacao dos alvos antigos e provisionamento dos novos
- preview mockado de credencial operacional para simulacao

## Cenarios cobertos

### Reserva normal

```bash
npm run test:yes:access:normal
```

### Early check-in

```bash
npm run test:yes:access:early-checkin
```

### Late check-out

```bash
npm run test:yes:access:late-checkout
```

### Troca de apartamento

```bash
npm run test:yes:access:room-change
```

### Cancelamento

```bash
npm run test:yes:access:cancel
```

## Limitacoes atuais

- nao ha persistencia
- nao ha leitura do catalogo real no banco
- nao ha integracao com HITS
- nao ha integracao com TTLock
- o preview de credencial e mockado e nao representa a regra final de producao
- nao ha reconciliacao automatica nem orquestracao operacional

## Proximos passos

1. validar estas regras internas com o fluxo operacional desejado
2. conectar no futuro este core ao adaptador de dados do HITS
3. conectar depois ao provisionamento real da TTLock
4. so entao discutir persistencia e automacao
