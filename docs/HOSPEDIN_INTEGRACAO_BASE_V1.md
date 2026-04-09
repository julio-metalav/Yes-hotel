# Hospedin → Yes — integração base (pull) — v1

## 1. Documentação oficial da API

No repositório **não há** PDF/OpenAPI da Hospedin. Não foi localizada documentação pública estável (autenticação e paths) em buscas externas genéricas. Esta fase trata a Hospedin como **provedor configurável**:

- Variáveis de ambiente definem **base URL**, **path**, **query** e **cabeçalhos** de autenticação.
- O corpo JSON é normalizado de forma **defensiva** em `supabase/functions/_shared/pms-hospedin-mapper.ts` (arrays na raiz, `data`, `reservations`, etc.).

**Ação necessária (fase 2):** anexar ao projeto o contrato oficial da Hospedin (OpenAPI ou manual) e alinhar nomes de campos, filtros por data e, se existir, **delta por `updated_at`**.

## 2. Modelo de dados espelho (Supabase)

Definido em `supabase/migrations/0020_yes_hotel_pms_hospedin_mirror.sql`:

| Tabela | Função |
|--------|--------|
| `pms_sync_runs` | Auditoria de execuções (status, intervalo de datas, estatísticas). |
| `pms_sync_errors` | Erros por run (step, mensagem, contexto JSON). |
| `pms_reservas` | Espelho da reserva (`provider` + `external_reservation_id` único, `raw_payload`, cancelamento, pagamento mapeado). |
| `pms_hospedes` | Espelho do hóspede no PMS (`provider` + `external_guest_id` único). |
| `pms_reserva_hospedes` | Vínculo N:N com `is_principal` e `ordem`. |

Projeção operacional:

- `operacional_reservas.origem_externa = 'hospedin'` e `external_reservation_id` idempotente (índice único parcial).
- `operacional_hospedes.pms_external_guest_id` para upsert por hóspede (índice único parcial `(reserva_id, pms_external_guest_id)`).

## 3. Sync (Edge Function)

**Nome:** `pms-hospedin-sync`

**Comportamento:**

1. Janela padrão: **ontem** até **hoje + 30 dias** (UTC) nos parâmetros de query configuráveis.
2. `GET` (ou `POST` se `HOSPEDIN_LIST_METHOD=POST`) na URL montada.
3. Normalização → upsert espelho → projeção em `operacional_*`.
4. Reserva **cancelada** no PMS: espelho com `is_cancelled`; linha operacional **removida** (cascade em hóspedes/FNRH/credenciais conforme FKs existentes).
5. Hóspedes que sumiram do payload PMS para aquela reserva: removidos do operacional **somente** se tinham `pms_external_guest_id` (hóspedes manuais sem id PMS não são apagados).

**Teste sem API real:** `POST` com JSON `{ "mock_payload": [ ... ] }` (mesmo formato que a API devolveria após `JSON.parse`).

### Variáveis de ambiente (secrets Supabase)

| Variável | Obrigatório | Descrição |
|----------|-------------|-----------|
| `HOSPEDIN_API_BASE_URL` | Sim (exceto mock) | Ex.: `https://api.exemplo.hospedin.com` |
| `HOSPEDIN_API_TOKEN` | Conforme contrato | Token ou chave. |
| `HOSPEDIN_AUTH_MODE` | Não | `bearer` (default) ou `header` (usa `HOSPEDIN_API_KEY_HEADER`). |
| `HOSPEDIN_AUTH_PREFIX` | Não | Default `Bearer`. |
| `HOSPEDIN_API_KEY_HEADER` | Se `header` | Nome do header (ex.: `X-Api-Key`). |
| `HOSPEDIN_RESERVATIONS_PATH` | Não | Default `/reservations`. |
| `HOSPEDIN_QUERY_DATE_FROM_PARAM` | Não | Default `check_in_from`. |
| `HOSPEDIN_QUERY_DATE_TO_PARAM` | Não | Default `check_in_to`. |
| `HOSPEDIN_EXTRA_QUERY` | Não | Ex.: `hotel_id=123&foo=bar` |
| `HOSPEDIN_EXTRA_HEADERS_JSON` | Não | JSON objeto com headers extras. |
| `HOSPEDIN_LIST_METHOD` | Não | `GET` ou `POST`. |
| `HOSPEDIN_LIST_POST_BODY_JSON` | Se POST | Template JSON com `{date_from}` e `{date_to}`. |
| `HOSPEDIN_SYNC_SECRET` | Recomendado em prod | Se definido, exige header `x-hospedin-sync-secret` igual ao valor. |

## 4. Regras de negócio já alinhadas no Yes

- **Múltiplos hóspedes → múltiplos links FNRH:** trigger `operacional_hospedes_criar_fnrh` (`0019`) cria `fnrh_hospedes` por linha em `operacional_hospedes`.
- **Status agregado:** `fnrh-submit` atualiza `fnrh_status_agregado` (pendente / parcial / completo).
- **Senha automática só com FNRH completa:** `send-senha` (automático) e `senha-auto-envio` exigem `fnrh_status_agregado = fnrh_completo` e `fnrh_completo_em`; envio manual continua permitido.
- **Pré-preenchimento FNRH:** após upsert do hóspede operacional, a sync atualiza `fnrh_hospedes` **apenas** com `status = pendente`, preenchendo campos a partir do **mesmo** hóspede PMS (sem herdar nome/documento entre hóspedes). Endereço compartilhável entre acompanhantes é tratado no mapper (cópia só de logradouro/cidade/UF/país/CEP a partir do principal quando vazios).

## 5. Próximos passos (fase 2)

1. Validar com a Hospedin: autenticação, path real, nomes dos campos de reserva/hóspede e filtro por intervalo ou por alteração.
2. Ajustar `pms-hospedin-mapper.ts` para o contrato real (sem alterar a ideia de idempotência).
3. Agendar cron (Supabase Scheduler ou externo) chamando a function com secret.
4. Paginação e rate limit, se a API exigir.
5. Write-back FNRH → PMS (fora de escopo atual).

## 6. Operação

- Deploy: `supabase functions deploy pms-hospedin-sync`
- Migração: aplicar `0020_yes_hotel_pms_hospedin_mirror.sql` no projeto Supabase.
