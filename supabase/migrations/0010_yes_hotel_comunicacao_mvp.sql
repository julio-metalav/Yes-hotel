-- Módulo de comunicação da hospedagem (substituição DigiSac) — MVP 1.
-- Conversas, mensagens, templates e eventos; preparado para canal WhatsApp futuro.
-- Não duplica núcleo: reserva_id/hospede_id são referências ao núcleo operacional.

-- Conversas (uma por canal + telefone; opcionalmente vinculada a reserva/hóspede)
create table if not exists public.comunicacao_conversas (
  id uuid primary key default gen_random_uuid(),
  canal text not null default 'whatsapp' check (canal in ('whatsapp', 'interno')),
  telefone text not null default '',
  reserva_id uuid references public.operacional_reservas (id) on delete set null,
  hospede_id uuid references public.operacional_hospedes (id) on delete set null,
  status text not null default 'aberta' check (status in ('aberta', 'aguardando_hospede', 'resolvida')),
  ultima_mensagem_em timestamptz,
  ultima_mensagem_preview text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists comunicacao_conversas_reserva_id_idx on public.comunicacao_conversas (reserva_id);
create index if not exists comunicacao_conversas_hospede_id_idx on public.comunicacao_conversas (hospede_id);
create index if not exists comunicacao_conversas_ultima_em_idx on public.comunicacao_conversas (ultima_mensagem_em desc nulls last);
-- Mensagens (entrada, saída, sistema)
create table if not exists public.comunicacao_mensagens (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.comunicacao_conversas (id) on delete cascade,
  direcao text not null check (direcao in ('entrada', 'saida', 'sistema')),
  tipo_mensagem text not null default 'texto' check (tipo_mensagem in ('texto', 'evento', 'template', 'sistema')),
  mensagem text not null default '',
  status_envio text check (status_envio is null or status_envio in ('enviando', 'enviada', 'entregue', 'lida', 'falha')),
  provider_message_id text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create index if not exists comunicacao_mensagens_conversa_id_idx on public.comunicacao_mensagens (conversa_id);
create index if not exists comunicacao_mensagens_created_at_idx on public.comunicacao_mensagens (conversa_id, created_at);
-- Templates (para respostas rápidas e automações futuras)
create table if not exists public.comunicacao_templates (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  titulo text not null default '',
  conteudo text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists comunicacao_templates_ativo_idx on public.comunicacao_templates (ativo) where ativo = true;
-- Eventos do sistema (ex.: link FNRH enviado, acesso liberado)
create table if not exists public.comunicacao_eventos (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid references public.comunicacao_conversas (id) on delete set null,
  reserva_id uuid references public.operacional_reservas (id) on delete set null,
  tipo_evento text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists comunicacao_eventos_conversa_id_idx on public.comunicacao_eventos (conversa_id);
create index if not exists comunicacao_eventos_reserva_id_idx on public.comunicacao_eventos (reserva_id);
-- RLS
alter table public.comunicacao_conversas enable row level security;
alter table public.comunicacao_mensagens enable row level security;
alter table public.comunicacao_templates enable row level security;
alter table public.comunicacao_eventos enable row level security;
create policy comunicacao_conversas_select on public.comunicacao_conversas for select to authenticated using (true);
create policy comunicacao_conversas_insert on public.comunicacao_conversas for insert to authenticated with check (true);
create policy comunicacao_conversas_update on public.comunicacao_conversas for update to authenticated using (true);
create policy comunicacao_mensagens_select on public.comunicacao_mensagens for select to authenticated using (true);
create policy comunicacao_mensagens_insert on public.comunicacao_mensagens for insert to authenticated with check (true);
create policy comunicacao_templates_select on public.comunicacao_templates for select to authenticated using (true);
create policy comunicacao_templates_insert on public.comunicacao_templates for insert to authenticated with check (true);
create policy comunicacao_templates_update on public.comunicacao_templates for update to authenticated using (true);
create policy comunicacao_eventos_select on public.comunicacao_eventos for select to authenticated using (true);
create policy comunicacao_eventos_insert on public.comunicacao_eventos for insert to authenticated with check (true);
-- updated_at para conversas
create or replace function public.set_comunicacao_conversas_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
drop trigger if exists comunicacao_conversas_updated_at on public.comunicacao_conversas;
create trigger comunicacao_conversas_updated_at
  before update on public.comunicacao_conversas
  for each row execute function public.set_comunicacao_conversas_updated_at();
