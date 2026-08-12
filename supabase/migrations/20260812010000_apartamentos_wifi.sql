-- Wi-Fi por apartamento (SSID + senha). Nullable. Sem backfill.
-- RLS: ops reader pode ler/atualizar; anon sem acesso.

alter table public.apartamentos
  add column if not exists wifi_ssid text,
  add column if not exists wifi_password text;

comment on column public.apartamentos.wifi_ssid is
  'SSID Wi-Fi do apartamento (opcional). Exibido ao hospede so no welcome pos-entrada.';
comment on column public.apartamentos.wifi_password is
  'Senha Wi-Fi do apartamento (opcional). Nunca em listagens publicas; so ops + envio ao hospede do apto.';

alter table public.apartamentos enable row level security;

drop policy if exists apartamentos_select_ops on public.apartamentos;
create policy apartamentos_select_ops
  on public.apartamentos
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

drop policy if exists apartamentos_update_ops on public.apartamentos;
create policy apartamentos_update_ops
  on public.apartamentos
  for update
  to authenticated
  using (public.is_yes_hotel_ops_reader())
  with check (public.is_yes_hotel_ops_reader());

-- service_role bypassa RLS; sem policy INSERT/DELETE para authenticated.

-- Propositos de comunicacao: acesso pre-chegada + boas-vindas pos-entrada.
alter table public.operacional_comunicacao_envios
  drop constraint if exists operacional_comunicacao_envios_proposito_check;

alter table public.operacional_comunicacao_envios
  add constraint operacional_comunicacao_envios_proposito_check
  check (proposito in (
    'fnrh_links',
    'senha_acesso',
    'guest_access_ready',
    'guest_first_access_welcome',
    'chat_operador',
    'generico'
  ));
