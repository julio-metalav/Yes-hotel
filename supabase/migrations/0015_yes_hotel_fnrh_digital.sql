-- FNRH digital: coleta e armazenamento por hóspede (dado operacional).
-- Uma FNRH por hóspede da reserva; status agregado na reserva.

create table public.fnrh_hospedes (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null references public.operacional_reservas (id) on delete cascade,
    hospede_id uuid not null references public.operacional_hospedes (id) on delete cascade,
    link_token text not null,
    hospede_nome text not null default '',
    documento text not null default '',
    data_nascimento date,
    nacionalidade text not null default '',
    endereco text not null default '',
    telefone text not null default '',
    email text not null default '',
    procedencia text not null default '',
    destino text not null default '',
    placa_veiculo text not null default '',
    assinatura_base64 text,
    status text not null default 'pendente' check (status in ('pendente', 'preenchido')),
    preenchido_em timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint fnrh_hospedes_reserva_hospede_key unique (reserva_id, hospede_id),
    constraint fnrh_hospedes_link_token_key unique (link_token)
);
create index fnrh_hospedes_reserva_id_idx on public.fnrh_hospedes (reserva_id);
create index fnrh_hospedes_hospede_id_idx on public.fnrh_hospedes (hospede_id);
create index fnrh_hospedes_link_token_idx on public.fnrh_hospedes (link_token);
comment on table public.fnrh_hospedes is 'FNRH digital por hóspede; link_token usado na URL pública de preenchimento.';
-- Status agregado na reserva (fnrh_pendente | fnrh_parcial | fnrh_completo)
alter table public.operacional_reservas
    add column if not exists fnrh_status_agregado text not null default 'fnrh_pendente'
    check (fnrh_status_agregado in ('fnrh_pendente', 'fnrh_parcial', 'fnrh_completo'));
comment on column public.operacional_reservas.fnrh_status_agregado is 'Status FNRH da reserva: pendente, parcial ou completo.';
-- RLS: fnrh_hospedes (formulário e submit via Edge Function com service_role; painel com authenticated)
alter table public.fnrh_hospedes enable row level security;
create policy fnrh_hospedes_select_auth on public.fnrh_hospedes
    for select to authenticated using (true);
create policy fnrh_hospedes_insert_auth on public.fnrh_hospedes
    for insert to authenticated with check (true);
create policy fnrh_hospedes_update_auth on public.fnrh_hospedes
    for update to authenticated using (true);
create policy fnrh_hospedes_all_service on public.fnrh_hospedes
    for all to service_role using (true) with check (true);
-- Trigger updated_at
drop trigger if exists fnrh_hospedes_updated_at on public.fnrh_hospedes;
create trigger fnrh_hospedes_updated_at
    before update on public.fnrh_hospedes
    for each row execute function public.set_updated_at();
