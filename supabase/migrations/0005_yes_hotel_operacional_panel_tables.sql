-- Bloco 01: Tabelas para o painel operacional (fonte da verdade do check-in).
-- Modelo mínimo para operar o painel sem mock; compatível com futura referência HITS.

create table if not exists public.operacional_reservas (
    id uuid primary key default gen_random_uuid(),
    apartamento text not null default '',
    hospede_principal text not null default '',
    check_in_previsto date not null default current_date,
    check_out_previsto date not null default current_date,
    pagamento_status text not null default 'pendente' check (pagamento_status in ('pendente', 'pago')),
    acesso_liberado boolean not null default false,
    entrou_no_apto boolean not null default false,
    veiculo_placa text not null default '',
    veiculo_cor text not null default '',
    origem_externa text not null default 'manual',
    external_reservation_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.operacional_hospedes (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null references public.operacional_reservas (id) on delete cascade,
    nome text not null default '',
    principal boolean not null default false,
    email text not null default '',
    whatsapp text not null default '',
    status_operacional text not null default 'nao_identificado' check (status_operacional in (
        'nao_identificado', 'aguardando_contato', 'pronto_para_envio', 'enviado', 'confirmado'
    )),
    origem_cadastro text not null default 'novo' check (origem_cadastro in (
        'existente_completo', 'existente_incompleto', 'novo', 'agencia_sem_dados'
    )),
    modo_coleta_fnrh text not null default 'preenchimento_completo' check (modo_coleta_fnrh in (
        'confirmacao_simplificada', 'preenchimento_completo'
    )),
    ultimo_envio_canal text,
    ultimo_envio_em text,
    tentativas_envio integer not null default 0 check (tentativas_envio >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists operacional_hospedes_reserva_id_idx
    on public.operacional_hospedes (reserva_id);

create table if not exists public.operacional_reserva_eventos (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null references public.operacional_reservas (id) on delete cascade,
    tipo text not null,
    titulo text not null,
    detalhe text,
    criado_em timestamptz not null default now()
);

create index if not exists operacional_reserva_eventos_reserva_id_idx
    on public.operacional_reserva_eventos (reserva_id);

-- RLS: apenas usuários autenticados com perfil interno podem acessar
alter table public.operacional_reservas enable row level security;
alter table public.operacional_hospedes enable row level security;
alter table public.operacional_reserva_eventos enable row level security;

-- Políticas: authenticated pode tudo (perfil checado na aplicação; depois pode refinar por role)
create policy operacional_reservas_select
    on public.operacional_reservas for select to authenticated using (true);
create policy operacional_reservas_insert
    on public.operacional_reservas for insert to authenticated with check (true);
create policy operacional_reservas_update
    on public.operacional_reservas for update to authenticated using (true);
create policy operacional_reservas_delete
    on public.operacional_reservas for delete to authenticated using (true);

create policy operacional_hospedes_select
    on public.operacional_hospedes for select to authenticated using (true);
create policy operacional_hospedes_insert
    on public.operacional_hospedes for insert to authenticated with check (true);
create policy operacional_hospedes_update
    on public.operacional_hospedes for update to authenticated using (true);
create policy operacional_hospedes_delete
    on public.operacional_hospedes for delete to authenticated using (true);

create policy operacional_reserva_eventos_select
    on public.operacional_reserva_eventos for select to authenticated using (true);
create policy operacional_reserva_eventos_insert
    on public.operacional_reserva_eventos for insert to authenticated with check (true);

-- updated_at automático
create or replace function public.set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists operacional_reservas_updated_at on public.operacional_reservas;
create trigger operacional_reservas_updated_at
    before update on public.operacional_reservas
    for each row execute function public.set_updated_at();

drop trigger if exists operacional_hospedes_updated_at on public.operacional_hospedes;
create trigger operacional_hospedes_updated_at
    before update on public.operacional_hospedes
    for each row execute function public.set_updated_at();
