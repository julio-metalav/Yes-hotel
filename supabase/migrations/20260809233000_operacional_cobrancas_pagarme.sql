-- Cobrança Pagar.me (MVP): classificação de comissionamento + cobrança + pagamento + webhooks.
-- NÃO aplicar automaticamente. Gate humano obrigatório (mesmo padrão de
-- 20260806163903_operacional_reservas_hits_sync_chegadas.sql).
-- NÃO aplicar em produção Vercel/Supabase nesta rodada — só revisão local.
--
-- Decisões de negócio já fechadas (ver histórico da rodada de planejamento):
-- - HITS continua sendo a fonte oficial da situação financeira da reserva
--   (pagamento_status, já existente em operacional_reservas — inalterado aqui).
-- - "Sem pagamento no HITS" e "comissionada" são fatos INDEPENDENTES — nunca
--   comprimidos em uma única coluna. Ver classificacao_comissionamento abaixo.
-- - Cobrança (tentativa) e pagamento (fato financeiro) são entidades distintas:
--   operacional_cobrancas_pagarme vs operacional_pagamentos_pagarme.
-- - Uma cobrança pode existir sem pagamento; nunca o inverso.
-- - Nenhum dado de cartão é armazenado em nenhuma hipótese.
-- - status é o estado NORMALIZADO do Yes Hotel; pagarme_status_raw é só espelho
--   de auditoria do último status literal confirmado server-to-server —
--   nunca usar pagarme_status_raw para decisão operacional sem normalização.
-- - Webhook é gatilho, não prova: a confirmação de pagamento exige consulta
--   server-to-server à API Pagar.me antes de gravar operacional_pagamentos_pagarme
--   (implementado em checkpoint futuro; aqui só o schema que sustenta isso).
-- - classificacao_comissionamento* é GATE FINANCEIRO (comissionada nunca pode
--   ser cobrada; desconhecida bloqueia cobrança) — protegido por trigger no
--   próprio banco (seção 1b), não só por RLS/UI, porque operacional_reservas
--   já tem RLS permissiva para authenticated herdada de 0005 e não é reescrita
--   aqui (mudar isso quebraria o painel de produção atual).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Classificação de comissionamento da reserva (independente de pagamento_status)
-- ---------------------------------------------------------------------------
alter table public.operacional_reservas
  add column if not exists classificacao_comissionamento text
    not null default 'desconhecida',
  add column if not exists classificacao_comissionamento_origem text
    not null default 'indefinido',
  add column if not exists classificacao_comissionamento_atualizado_em timestamptz;

alter table public.operacional_reservas
  drop constraint if exists operacional_reservas_classificacao_comissionamento_check;

alter table public.operacional_reservas
  add constraint operacional_reservas_classificacao_comissionamento_check
  check (classificacao_comissionamento in ('nao_comissionada', 'comissionada', 'desconhecida'));

alter table public.operacional_reservas
  drop constraint if exists operacional_reservas_classificacao_comissionamento_origem_check;

alter table public.operacional_reservas
  add constraint operacional_reservas_classificacao_comissionamento_origem_check
  check (classificacao_comissionamento_origem in ('hits_campo', 'manual_operador', 'indefinido'));

comment on column public.operacional_reservas.classificacao_comissionamento is
  'nao_comissionada|comissionada|desconhecida. Independente de pagamento_status: '
  '"sem pagamento no HITS" não é sinônimo de "hóspede deve dinheiro". '
  'Enquanto desconhecida, NENHUMA cobrança Pagar.me pode ser criada (regra de aplicação).';
comment on column public.operacional_reservas.classificacao_comissionamento_origem is
  'hits_campo|manual_operador|indefinido. Hoje sempre manual_operador na prática: '
  'nenhum campo do HITS real (commissions[]/companyName/reservationChannelId) foi '
  'confirmado com dado autenticado. Ver docs/YES_HOTEL_CONTRATO_TECNICO_HITS_V1.md.';
comment on column public.operacional_reservas.classificacao_comissionamento_atualizado_em is
  'Quando a classificação foi definida/alterada pela última vez. Autoria fica em '
  'operacional_reserva_eventos, não nesta coluna.';

-- ---------------------------------------------------------------------------
-- 1b) Proteção de escrita das colunas de comissionamento (gate financeiro)
--
-- operacional_reservas tem RLS permissiva para authenticated (using(true) em
-- INSERT/UPDATE, herdada de 0005) e esta migration NÃO reescreve essa RLS —
-- faria isso quebraria o painel de produção atual, que já escreve direto
-- nessa tabela via client Supabase. A proteção destas 3 colunas específicas
-- é feita no nível de trigger, que roda independente de RLS:
--
-- - INSERT por role não privilegiada: os 3 campos são sempre forçados para
--   os defaults seguros (desconhecida/indefinido/NULL), não importa o que o
--   client tenha enviado. Fluxos existentes (painel, syncs HITS/Hospedin) não
--   preenchem esses campos hoje, então continuam funcionando sem mudança.
-- - UPDATE por role não privilegiada: qualquer tentativa de alterar um dos 3
--   campos é rejeitada (exceção 42501). Demais colunas da mesma linha podem
--   continuar sendo atualizadas normalmente (ex.: acesso_liberado,
--   pagamento_status) — o bloqueio é só nesses 3 campos.
-- - Role privilegiada (service_role, ou papéis administrativos usados por
--   migration/backend: postgres/supabase_admin, ou sessão com is_superuser)
--   pode ler e escrever livremente. A classificação manual pelo operador
--   deverá, no checkpoint da API, passar por uma Edge Function autenticada
--   que valida o perfil do usuário e escreve usando a service_role key —
--   nunca diretamente do client com o JWT do operador.
-- ---------------------------------------------------------------------------
create or replace function public.yes_hotel_is_privileged_writer()
returns boolean
language sql
stable
as $$
  select current_user in ('service_role', 'postgres', 'supabase_admin')
      or coalesce(current_setting('is_superuser', true), 'off') = 'on';
$$;

comment on function public.yes_hotel_is_privileged_writer() is
  'True quando a sessão de banco atual é service_role ou papel administrativo '
  '(migration/backend), nunca authenticated/anon. Usado para proteger colunas '
  'sensíveis contra escrita direta via client, independente de RLS/UI.';

create or replace function public.operacional_reservas_protect_comissionamento()
returns trigger
language plpgsql
as $$
begin
  if public.yes_hotel_is_privileged_writer() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Não confia no que o client enviou: sempre nasce com os defaults seguros.
    new.classificacao_comissionamento := 'desconhecida';
    new.classificacao_comissionamento_origem := 'indefinido';
    new.classificacao_comissionamento_atualizado_em := null;
    return new;
  end if;

  if new.classificacao_comissionamento is distinct from old.classificacao_comissionamento
     or new.classificacao_comissionamento_origem is distinct from old.classificacao_comissionamento_origem
     or new.classificacao_comissionamento_atualizado_em is distinct from old.classificacao_comissionamento_atualizado_em
  then
    raise exception
      'classificacao_comissionamento só pode ser alterada via backend/service_role (Edge Function autenticada), nunca diretamente por authenticated.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.operacional_reservas_protect_comissionamento() is
  'Gate financeiro: impede que authenticated/anon alterem classificacao_comissionamento* '
  'diretamente. Só service_role/papel administrativo pode escrever esses 3 campos.';

drop trigger if exists operacional_reservas_protect_comissionamento
  on public.operacional_reservas;
create trigger operacional_reservas_protect_comissionamento
  before insert or update on public.operacional_reservas
  for each row execute function public.operacional_reservas_protect_comissionamento();

-- ---------------------------------------------------------------------------
-- 2) Cobrança Pagar.me (a tentativa — pode existir sem pagamento)
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_cobrancas_pagarme (
  id uuid primary key default gen_random_uuid(),
  reserva_id uuid not null
    references public.operacional_reservas (id) on delete restrict,
  external_reservation_id text,
  origem_cobranca text not null default 'yes_hotel_pagarme',
  metodo text not null
    check (metodo in ('pix', 'cartao')),
  valor_centavos integer not null
    check (valor_centavos > 0),
  moeda text not null default 'BRL',
  idempotency_key text not null,

  -- Identificadores Pagar.me — nascem em estágios diferentes conforme o método.
  -- Cartão: payment_link_id/url nascem na criação; order_id/charge_id só
  -- existem quando o hóspede efetivamente inicia/conclui o pagamento.
  -- Pix: order_id/charge_id nascem já na criação (cobrança direta, sem link).
  pagarme_payment_link_id text,
  pagarme_payment_link_url text,
  pagarme_order_id text,
  pagarme_charge_id text,

  -- Pix: dados públicos de exibição ao pagador, nunca sensíveis — mas não
  -- devem ficar acessíveis fora do operador autorizado (ver RLS abaixo).
  pix_qr_code text,
  pix_qr_code_url text,

  -- Espelho do expires_at/expires_in retornado pela própria Pagar.me na
  -- criação (link ou Pix). Nunca calculado localmente pelo Yes Hotel.
  expira_em timestamptz,

  -- Estado NORMALIZADO do Yes Hotel. Ver pagarme_status_raw para o literal.
  status text not null default 'created'
    check (status in (
      'created', 'pending', 'processing', 'paid',
      'expired', 'canceled', 'failed', 'refunded', 'chargeback'
    )),

  -- Último status literal confirmado server-to-server na Pagar.me (auditoria/
  -- evolução futura sem migration a cada estado novo). Nunca usar para decisão
  -- operacional sem passar pela normalização acima.
  pagarme_status_raw text,

  -- charge.underpaid / charge.overpaid / charge.partial_canceled: no MVP não
  -- viram 'paid' automaticamente nem estado novo no enum — só marcam a
  -- cobrança para revisão humana, preservando o status atual.
  requer_revisao_operacional boolean not null default false,
  requer_revisao_motivo text
    check (requer_revisao_motivo is null or requer_revisao_motivo in (
      'charge_underpaid', 'charge_overpaid', 'charge_partial_canceled'
    )),
  requer_revisao_detectado_em timestamptz,

  criado_por_user_id uuid not null
    references public.usuarios_internos (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint operacional_cobrancas_pagarme_idempotency_uidx unique (idempotency_key)
);

comment on table public.operacional_cobrancas_pagarme is
  'Cobrança Pagar.me criada manualmente pelo operador (situação 2: não comissionada, '
  'sem pagamento no HITS). Nunca criada automaticamente. Nunca guarda dado de cartão.';
comment on column public.operacional_cobrancas_pagarme.status is
  'Estado normalizado do Yes Hotel. chargeback é canônico único: mapeia tanto '
  'charge.chargedback (legado) quanto chargeback.received (novo, substituto oficial).';
comment on column public.operacional_cobrancas_pagarme.pagarme_status_raw is
  'Último status literal confirmado via consulta server-to-server à API Pagar.me. '
  'Auditoria/evolução futura — NUNCA usar isoladamente para decisão operacional.';
comment on column public.operacional_cobrancas_pagarme.requer_revisao_operacional is
  'true quando charge.underpaid/overpaid/partial_canceled foi recebido e confirmado '
  'server-to-server. Não altera status automaticamente — exige revisão humana.';
comment on column public.operacional_cobrancas_pagarme.expira_em is
  'Espelho do expires_at/expires_in retornado pela Pagar.me na criação (link ou Pix). '
  'Autoridade de expiração é sempre a Pagar.me, nunca cálculo local.';

-- Coerência dos campos de revisão operacional: os três andam juntos, sempre.
-- A aplicação deve atualizar os três atomicamente (mesmo UPDATE).
alter table public.operacional_cobrancas_pagarme
  drop constraint if exists operacional_cobrancas_pagarme_revisao_coerente_check;

alter table public.operacional_cobrancas_pagarme
  add constraint operacional_cobrancas_pagarme_revisao_coerente_check
  check (
    (
      requer_revisao_operacional = false
      and requer_revisao_motivo is null
      and requer_revisao_detectado_em is null
    ) or (
      requer_revisao_operacional = true
      and requer_revisao_motivo is not null
      and requer_revisao_detectado_em is not null
    )
  );

-- Consistência método × campos específicos: impede misturar acidentalmente os
-- dois fluxos do MVP. order_id/charge_id continuam permitidos nos dois métodos
-- (nascem em estágios diferentes — ver comentário acima). metodo é definido na
-- criação e nunca muda depois, então esta constraint não atrapalha transições
-- legítimas de status.
alter table public.operacional_cobrancas_pagarme
  drop constraint if exists operacional_cobrancas_pagarme_metodo_campos_check;

alter table public.operacional_cobrancas_pagarme
  add constraint operacional_cobrancas_pagarme_metodo_campos_check
  check (
    (metodo = 'cartao' and pix_qr_code is null and pix_qr_code_url is null)
    or
    (metodo = 'pix' and pagarme_payment_link_id is null and pagarme_payment_link_url is null)
  );

-- Concorrência MVP: no máximo UMA cobrança BLOQUEANTE por reserva.
-- Inclui created/pending/processing (duplo clique / duas abas / dois operadores)
-- E paid/refunded/chargeback (obrigação corrente liquidada ou contenciosa).
-- failed/expired/canceled ficam FORA e permitem nova tentativa.
--
-- Por que paid/refunded/chargeback estão no índice (mudança vs rascunho inicial):
-- SELECT+INSERT na aplicação NÃO fecha a race entre webhook confirmar paid e
-- um segundo criar(). O índice único parcial serializa ambos no Postgres:
-- a transição pending→paid permanece dentro do mesmo predicado, sem janela
-- em que uma segunda linha 'created' possa nascer.
--
-- Futura nova obrigação legítima na mesma reserva (ex.: extensão/novo saldo)
-- exigirá workflow explícito de encerramento da obrigação anterior — fora
-- deste checkpoint. Neste MVP, segurança contra cobrança dupla tem prioridade.
drop index if exists public.operacional_cobrancas_pagarme_reserva_ativa_uidx;
create unique index if not exists operacional_cobrancas_pagarme_reserva_ativa_uidx
  on public.operacional_cobrancas_pagarme (reserva_id)
  where status in (
    'created', 'pending', 'processing',
    'paid', 'refunded', 'chargeback'
  );

create unique index if not exists operacional_cobrancas_pagarme_payment_link_id_uidx
  on public.operacional_cobrancas_pagarme (pagarme_payment_link_id)
  where pagarme_payment_link_id is not null;

create unique index if not exists operacional_cobrancas_pagarme_order_id_uidx
  on public.operacional_cobrancas_pagarme (pagarme_order_id)
  where pagarme_order_id is not null;

create unique index if not exists operacional_cobrancas_pagarme_charge_id_uidx
  on public.operacional_cobrancas_pagarme (pagarme_charge_id)
  where pagarme_charge_id is not null;

create index if not exists operacional_cobrancas_pagarme_reserva_idx
  on public.operacional_cobrancas_pagarme (reserva_id);

create index if not exists operacional_cobrancas_pagarme_status_idx
  on public.operacional_cobrancas_pagarme (status);

create index if not exists operacional_cobrancas_pagarme_revisao_idx
  on public.operacional_cobrancas_pagarme (requer_revisao_operacional)
  where requer_revisao_operacional = true;

drop trigger if exists operacional_cobrancas_pagarme_updated_at
  on public.operacional_cobrancas_pagarme;
create trigger operacional_cobrancas_pagarme_updated_at
  before update on public.operacional_cobrancas_pagarme
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) Pagamento Pagar.me (o FATO financeiro — separado de cobrança)
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_pagamentos_pagarme (
  id uuid primary key default gen_random_uuid(),
  cobranca_id uuid not null
    references public.operacional_cobrancas_pagarme (id) on delete restrict,
  valor_centavos_recebido integer not null
    check (valor_centavos_recebido > 0),
  moeda text not null default 'BRL',
  -- Data efetiva do pagamento (retornada pela Pagar.me), não a hora do webhook.
  -- É este campo que o financeiro futuro precisará para "liquidado na data do Pix".
  pago_em timestamptz not null,
  pagarme_charge_id text,
  pagarme_transaction_id text,
  pagarme_status_raw text,

  -- HITS continua sendo a fonte oficial da situação financeira da reserva.
  -- Este campo nunca é a mesma coisa que operacional_reservas.pagamento_status.
  sincronizacao_hits_status text not null default 'aguardando_registro_hits'
    check (sincronizacao_hits_status in (
      'nao_aplicavel',
      'aguardando_registro_hits',
      'registrado_aguardando_confirmacao',
      'confirmado_hits',
      'falha_registro_hits'
    )),
  -- Preenchido só quando IncludePayment (ou equivalente) existir e for chamado.
  -- Hoje sempre null — não há capacidade de escrita confirmada no HITS.
  hits_include_payment_ref text,

  created_at timestamptz not null default now(),
  -- Não é totalmente imutável: sincronizacao_hits_status, hits_include_payment_ref
  -- e eventualmente pagarme_status_raw podem mudar depois do pagamento confirmado.
  updated_at timestamptz not null default now(),

  constraint operacional_pagamentos_pagarme_cobranca_uidx unique (cobranca_id)
);

comment on table public.operacional_pagamentos_pagarme is
  'Fato financeiro: pagamento efetivamente confirmado via consulta server-to-server '
  'à Pagar.me. 1:1 com a cobrança que o originou (não antecipar 1:N financeiro).';
comment on column public.operacional_pagamentos_pagarme.pago_em is
  'Data efetiva do pagamento conforme a Pagar.me — não a hora de recebimento do webhook.';
comment on column public.operacional_pagamentos_pagarme.sincronizacao_hits_status is
  '"Pagar.me pago / regularização HITS pendente" é estado de SINCRONIZAÇÃO, nunca '
  'motivo para gerar segunda cobrança. HITS continua sendo a fonte oficial da reserva.';
comment on column public.operacional_pagamentos_pagarme.updated_at is
  'Rastreia quando sincronizacao_hits_status/hits_include_payment_ref/pagarme_status_raw '
  'mudaram pela última vez após o pagamento já confirmado.';

-- Impede que o mesmo fato externo da Pagar.me (charge/transaction) seja
-- associado a mais de um pagamento local, por bug, corrida ou webhook
-- duplicado. Não há razão técnica conhecida para permitir duplicidade aqui:
-- cada charge só pode ser paga uma vez, e operacional_pagamentos_pagarme já é
-- 1:1 com a cobrança (cujo charge_id já é único em operacional_cobrancas_pagarme).
create unique index if not exists operacional_pagamentos_pagarme_charge_id_uidx
  on public.operacional_pagamentos_pagarme (pagarme_charge_id)
  where pagarme_charge_id is not null;

create unique index if not exists operacional_pagamentos_pagarme_transaction_id_uidx
  on public.operacional_pagamentos_pagarme (pagarme_transaction_id)
  where pagarme_transaction_id is not null;

create index if not exists operacional_pagamentos_pagarme_sync_status_idx
  on public.operacional_pagamentos_pagarme (sincronizacao_hits_status);

drop trigger if exists operacional_pagamentos_pagarme_updated_at
  on public.operacional_pagamentos_pagarme;
create trigger operacional_pagamentos_pagarme_updated_at
  before update on public.operacional_pagamentos_pagarme
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) Log/idempotência de webhooks Pagar.me
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_cobranca_webhooks (
  id uuid primary key default gen_random_uuid(),
  cobranca_id uuid
    references public.operacional_cobrancas_pagarme (id) on delete set null,
  pagarme_event_id text not null,
  tipo_evento text not null,
  -- Sanitizado: nunca dado de cartão (que, por design, nunca deveria chegar
  -- aqui); QR/copia-e-cola/links completos não devem ser logados aqui em
  -- texto aberto além do necessário à correlação técnica (checkpoint futuro
  -- decide o nível exato de sanitização na gravação).
  payload_sanitizado jsonb not null default '{}'::jsonb,
  processado_em timestamptz,
  erro text,
  criado_em timestamptz not null default now(),

  constraint operacional_cobranca_webhooks_event_id_uidx unique (pagarme_event_id)
);

comment on table public.operacional_cobranca_webhooks is
  'Idempotência de eventos + auditoria técnica. Webhook é gatilho, não prova: a '
  'confirmação financeira exige consulta server-to-server antes de gravar pagamento. '
  'Eventos tratados no MVP: order.paid, order.payment_failed, order.canceled, '
  'charge.paid, charge.payment_failed, charge.pending, charge.processing, '
  'charge.refunded, charge.underpaid, charge.overpaid, charge.partial_canceled, '
  'charge.chargedback (legado), chargeback.received (novo), checkout.created, '
  'checkout.canceled, checkout.closed.';

create index if not exists operacional_cobranca_webhooks_cobranca_idx
  on public.operacional_cobranca_webhooks (cobranca_id);

create index if not exists operacional_cobranca_webhooks_criado_em_idx
  on public.operacional_cobranca_webhooks (criado_em desc);

-- ---------------------------------------------------------------------------
-- 5) Helpers de perfil (admin-only, para o log técnico de webhooks)
-- ---------------------------------------------------------------------------
create or replace function public.is_yes_hotel_admin_reader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.usuarios_internos u
    where u.auth_user_id = auth.uid()
      and u.ativo = true
      and lower(u.perfil_usuario) = 'admin'
  );
$$;

comment on function public.is_yes_hotel_admin_reader() is
  'True se o JWT atual pertence a usuario interno ativo com perfil admin. '
  'Usado para restringir leitura de payload técnico de webhooks Pagar.me.';

-- ---------------------------------------------------------------------------
-- 6) RLS — leitura só por operador autorizado; escrita só backend/service_role
-- ---------------------------------------------------------------------------
alter table public.operacional_cobrancas_pagarme enable row level security;
alter table public.operacional_pagamentos_pagarme enable row level security;
alter table public.operacional_cobranca_webhooks enable row level security;

-- Cobranças: admin + recepção (mesmo gate já usado em operacional_acesso_outbox).
drop policy if exists operacional_cobrancas_pagarme_select on public.operacional_cobrancas_pagarme;
create policy operacional_cobrancas_pagarme_select
  on public.operacional_cobrancas_pagarme
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists operacional_cobrancas_pagarme_write_deny on public.operacional_cobrancas_pagarme;
create policy operacional_cobrancas_pagarme_write_deny
  on public.operacional_cobrancas_pagarme
  for all
  to authenticated
  using (false)
  with check (false);

-- Pagamentos: mesmo gate — recepção precisa ver "pago no Pagar.me" no card.
drop policy if exists operacional_pagamentos_pagarme_select on public.operacional_pagamentos_pagarme;
create policy operacional_pagamentos_pagarme_select
  on public.operacional_pagamentos_pagarme
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists operacional_pagamentos_pagarme_write_deny on public.operacional_pagamentos_pagarme;
create policy operacional_pagamentos_pagarme_write_deny
  on public.operacional_pagamentos_pagarme
  for all
  to authenticated
  using (false)
  with check (false);

-- Webhooks: só admin — payload técnico, não é informação operacional do dia a dia.
drop policy if exists operacional_cobranca_webhooks_select on public.operacional_cobranca_webhooks;
create policy operacional_cobranca_webhooks_select
  on public.operacional_cobranca_webhooks
  for select
  to authenticated
  using (public.is_yes_hotel_admin_reader());

drop policy if exists operacional_cobranca_webhooks_write_deny on public.operacional_cobranca_webhooks;
create policy operacional_cobranca_webhooks_write_deny
  on public.operacional_cobranca_webhooks
  for all
  to authenticated
  using (false)
  with check (false);

revoke insert, update, delete on public.operacional_cobrancas_pagarme from authenticated, anon;
revoke insert, update, delete on public.operacional_pagamentos_pagarme from authenticated, anon;
revoke insert, update, delete on public.operacional_cobranca_webhooks from authenticated, anon;

grant select on public.operacional_cobrancas_pagarme to authenticated;
grant select on public.operacional_pagamentos_pagarme to authenticated;
grant select on public.operacional_cobranca_webhooks to authenticated;

COMMIT;

-- =============================================================================
-- ROLLBACK (manual; não executar em produção sem gate)
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS operacional_cobranca_webhooks_write_deny ON public.operacional_cobranca_webhooks;
-- DROP POLICY IF EXISTS operacional_cobranca_webhooks_select ON public.operacional_cobranca_webhooks;
-- DROP POLICY IF EXISTS operacional_pagamentos_pagarme_write_deny ON public.operacional_pagamentos_pagarme;
-- DROP POLICY IF EXISTS operacional_pagamentos_pagarme_select ON public.operacional_pagamentos_pagarme;
-- DROP POLICY IF EXISTS operacional_cobrancas_pagarme_write_deny ON public.operacional_cobrancas_pagarme;
-- DROP POLICY IF EXISTS operacional_cobrancas_pagarme_select ON public.operacional_cobrancas_pagarme;
-- DROP FUNCTION IF EXISTS public.is_yes_hotel_admin_reader();
-- DROP TABLE IF EXISTS public.operacional_cobranca_webhooks;
-- DROP TRIGGER IF EXISTS operacional_pagamentos_pagarme_updated_at ON public.operacional_pagamentos_pagarme;
-- DROP TABLE IF EXISTS public.operacional_pagamentos_pagarme;
-- DROP TRIGGER IF EXISTS operacional_cobrancas_pagarme_updated_at ON public.operacional_cobrancas_pagarme;
-- ALTER TABLE public.operacional_cobrancas_pagarme DROP CONSTRAINT IF EXISTS operacional_cobrancas_pagarme_metodo_campos_check;
-- ALTER TABLE public.operacional_cobrancas_pagarme DROP CONSTRAINT IF EXISTS operacional_cobrancas_pagarme_revisao_coerente_check;
-- DROP TABLE IF EXISTS public.operacional_cobrancas_pagarme;
-- DROP TRIGGER IF EXISTS operacional_reservas_protect_comissionamento ON public.operacional_reservas;
-- DROP FUNCTION IF EXISTS public.operacional_reservas_protect_comissionamento();
-- DROP FUNCTION IF EXISTS public.yes_hotel_is_privileged_writer();
-- ALTER TABLE public.operacional_reservas DROP CONSTRAINT IF EXISTS operacional_reservas_classificacao_comissionamento_origem_check;
-- ALTER TABLE public.operacional_reservas DROP CONSTRAINT IF EXISTS operacional_reservas_classificacao_comissionamento_check;
-- ALTER TABLE public.operacional_reservas DROP COLUMN IF EXISTS classificacao_comissionamento_atualizado_em;
-- ALTER TABLE public.operacional_reservas DROP COLUMN IF EXISTS classificacao_comissionamento_origem;
-- ALTER TABLE public.operacional_reservas DROP COLUMN IF EXISTS classificacao_comissionamento;
-- COMMIT;
