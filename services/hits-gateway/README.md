# Gateway HITS (leitura + escrita PAX sandbox)

Gateway Node.js para o Yes Hotel chamar a API HITS PMS a partir de IP público fixo (whitelist APP Sistemas).

Não faz deploy sozinho. Não altera Supabase, Edge, UI, migrations nem Certbot.

A escrita de PAX nesta versão é **somente homologação Sandbox**. Produção permanece bloqueada. Check-in, no-show, TTLock e UI **não** fazem parte deste escopo.

## Papel

```
Yes / Supabase Edge
        |  HTTPS + Bearer GATEWAY_TOKEN
        v
Nginx (443) → 127.0.0.1:3001
        v
Gateway HITS
        |  HitsClient (POST /Authorize interno + GET Datashare
        |  + POST/PUT Guests sandbox, se a trava estiver ligada)
        v
HITS PMS
```

O Node escuta **somente** `127.0.0.1`. Produção executa `node dist/server.js` — sem `tsx` e sem checkout de `src/` do monorepo em runtime.

## Ambientes

| | HOMO | PROD |
|---|---|---|
| Domínio | https://hits-homo.yeshotel.com.br | https://hits-prod.yeshotel.com.br |
| Reserved IP (egress) | 157.230.200.47 | 167.172.2.24 |

Mesmo código. Secrets e URLs separados. Nenhuma credencial de PROD no HOMO.

## Endpoints externos

| Método | Rota | Auth | Destino HITS |
|---|---|---|---|
| GET | `/health` | não | nenhum |
| GET | `/v1/reservations` | Bearer | `GET /Datashare/WebCheckinOut/Reservations` |
| GET | `/v1/reservations/:id` | Bearer | `GET /Datashare/WebCheckinOut/Reservation/{id}` |
| GET | `/v1/guests` | Bearer | `GET /Datashare/RevenueManagement/Guests` |
| POST | `/v1/reservations/:id/guests` | Bearer | `POST /Datashare/WebCheckinOut/Guests/{reservationId}` |
| PUT | `/v1/guests` | Bearer | `PUT /Datashare/WebCheckinOut/Guests` |

Todas as rotas `/v1/` exigem `Authorization: Bearer GATEWAY_TOKEN`.

POST/PUT/PATCH/DELETE em `/v1/reservations` e `/v1/reservations/:id` → **405**, sem HITS.
POST/PATCH/DELETE em `/v1/guests` → **405**.
`/Authorize`, `/Datashare`, CheckIn e no-show **não existem** neste serviço.

Escrita PAX (POST/PUT acima) parte **desligada**. Sem as três condições abaixo responde **403** `guest_write_disabled`, sem chamar o HITS:

1. configuração HITS completa (mesmo critério de `hitsReady`);
2. `HITS_TENANT_NAME` igual a `develop` (só diferença de maiúsculas/minúsculas é ignorada);
3. `HITS_GUEST_WRITE_ENABLED` exatamente `true`.

Se o tenant não for `develop`, a escrita permanece bloqueada **mesmo com a flag ativa**. Produção não deve usar tenant `develop`; nesta versão a escrita em produção fica bloqueada.

O tenant do Sandbox HITS é `develop`. `dev` **não** é aceito: além de não liberar a escrita, `HITS_TENANT_NAME=dev` faz a própria HITS rejeitar as leituras (comprovado em HOMO: `GET /v1/reservations/{id}` retorna 502 `hits_server_error` com `dev` e 200 com `develop`).

## Ciclo de vida do token HITS

A HITS informa que o Bearer vale **quatro horas**. O cliente do gateway:

- grava `obtainedAtMs` na sessão em memória;
- **consulta** essa idade antes de cada chamada autenticada;
- reutiliza o token só dentro de uma janela segura de **3h45** (margem de 15 minutos);
- no limite ou após 3h45, descarta a sessão e faz novo `POST /Authorize`;
- ao receber HTTP 401 da HITS, invalida imediatamente a sessão e **não** repete a operação que falhou;
- a próxima requisição independente obtém um token novo;
- chamadas concorrentes sem sessão compartilham a mesma autorização em andamento;
- falha de autorização limpa a promessa/sessão para uma tentativa futura independente.

POST e PUT para o HITS usam `maxRetries: 0` (sem retry automático), inclusive após 401.
Em sucesso, o gateway **não** reencaminha o JSON do HITS; responde só `{ "ok": true, "request_id": "..." }`.

Roteiro de homologação sandbox: [HOMOLOGACAO-PAX.md](./HOMOLOGACAO-PAX.md).

`GET /health` responde só:

```json
{ "status": "ok", "service": "hits-gateway", "version": "0.1.0" }
```

Query de lista: `Type`, `Status`, `InitialDate`, `FinalDate`, `ReservationIntegrationId`, `Page`, `Size` (contrato do `HitsClient`). Outros parâmetros são ignorados. `Size` teto 100.

Query de hóspedes: `EntityId`, `Since`, `DocType`, `Doc`, `Email`, `Page`, `Size`. `DocType`: 1=passaporte, 2=CPF, 3=RG, 7=certidão de nascimento. Outros parâmetros são ignorados e `Size` tem teto 100. Como `Doc` e `Email` são dados pessoais, o gateway remove a query string dos logs e o Nginx deve desativar o access log dessa rota.

## GATEWAY_TOKEN

- Só via env. Nunca no git, logs, README com valor real, nem responses.
- Mínimo **32 caracteres**.
- Gerar: `openssl rand -hex 32` (64 hex). HOMO ≠ PROD.
- Comparação em tempo constante. Ausência/erro → 401. Token curto → processo **não sobe**.

## Desenvolvimento local

```bash
cd services/hits-gateway
npm install
cp .env.example .env
# GATEWAY_TOKEN com openssl rand -hex 32. HITS_* pode ficar vazio.

npm run typecheck
npm test
npm run build
node dist/server.js
# equivalente: npm run start:prod
```

`npm start` (tsx) é só para desenvolvimento. Produção usa o `dist/`.

Sem `HITS_*` completos: `/health` ok; `/v1/*` autenticado → 503. Sem chamada à API real.

## Artefato de produção

`npm run build` gera `dist/server.js`:

- bundle do gateway + `HitsClient` interno;
- **sem** sourcemap;
- fastify / `@fastify/helmet` / `@fastify/rate-limit` externos (`npm ci --omit=dev` no servidor).

## trustProxy / Nginx

O Fastify confia em `X-Forwarded-*` **apenas** de `127.0.0.1` e `::1` (Nginx no mesmo host).
O exemplo Nginx define `X-Forwarded-For $remote_addr` (não concatena o header do cliente).

## Deploy HOMO (ainda não executar)

Pré-requisitos no droplet: Node 20+, Nginx + certificado Let's Encrypt já ativos, IP 157.230.200.47.

Build na máquina de CI/dev:

```bash
cd services/hits-gateway
npm ci
npm run typecheck
npm test
npm run build
```

No servidor (como root):

```bash
id hits-gateway >/dev/null 2>&1 || useradd --system --home-dir /opt/hits-gateway --shell /usr/sbin/nologin hits-gateway

mkdir -p /opt/hits-gateway /etc/hits-gateway
chown hits-gateway:hits-gateway /opt/hits-gateway
chmod 0750 /opt/hits-gateway
chown root:hits-gateway /etc/hits-gateway
chmod 0750 /etc/hits-gateway
```

Copiar artefato (ajustar origem):

```bash
rsync -a --delete dist package.json package-lock.json /opt/hits-gateway/
chown -R hits-gateway:hits-gateway /opt/hits-gateway
chmod 0750 /opt/hits-gateway
```

Dependências runtime:

```bash
cd /opt/hits-gateway
sudo -u hits-gateway npm ci --omit=dev
```

Env (editar valores; **não** colar secret em ticket/chat):

```bash
cp /caminho/do/repo/services/hits-gateway/deploy/hits-gateway.env.example /etc/hits-gateway/hits-gateway.env
chmod 0640 /etc/hits-gateway/hits-gateway.env
chown root:hits-gateway /etc/hits-gateway/hits-gateway.env
# preencher GATEWAY_TOKEN=$(openssl rand -hex 32)
# HITS_* podem permanecer vazios nesta fase
```

systemd:

```bash
cp /caminho/do/repo/services/hits-gateway/deploy/hits-gateway.service /etc/systemd/system/hits-gateway.service
systemctl daemon-reload
systemctl enable hits-gateway
systemctl start hits-gateway
systemctl status hits-gateway --no-pager
curl -sS http://127.0.0.1:3001/health
# esperado: {"status":"ok","service":"hits-gateway","version":"0.1.0"}
```

Nginx (depois de revisar o arquivo contra o vhost Certbot já existente — **não** reemitir certificado):

```bash
# integrar location/proxy no vhost atual OU instalar o exemplo e incluir o ssl já existente
nginx -t
systemctl reload nginx
curl -sS https://hits-homo.yeshotel.com.br/health
```

Logs: `journalctl -u hits-gateway -f`

## Variáveis

Confirmadas no código Yes: `HITS_API_BASE_URL`, `HITS_SHARED_ACCESS_SECRET`, `HITS_PROPERTY_ID`, `HITS_TENANT_NAME`, `HITS_PROPERTY_CODE`, `HITS_CLIENT_ID`, `HITS_PARTNER_USER_ID`, `HITS_API_VERSION`, `HITS_LANGUAGE_CODE`, `HITS_AUTHORIZE_SCOPES`, `HITS_REQUEST_TIMEOUT_MS`.

Deste serviço: `NODE_ENV`, `PORT` (3001), `GATEWAY_TOKEN`, `HITS_GUEST_WRITE_ENABLED`.

`HITS_GUEST_WRITE_ENABLED` só vale `true` (minúsculo, exato). Qualquer outro valor mantém a escrita desligada.

Pendentes APP Sistemas: secret, propertyId, tenant, property code, client id, URL sandbox, confirmação da whitelist.
