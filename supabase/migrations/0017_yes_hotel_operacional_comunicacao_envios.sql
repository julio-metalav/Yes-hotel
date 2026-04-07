-- Histórico interno de tentativas de comunicação operacional (DigiSac, Resend, etc.).
-- Service role grava via Edge Functions; operadores leem no painel (authenticated).

create table if not exists public.operacional_comunicacao_envios (
  id uuid primary key default gen_random_uuid(),
  reserva_id uuid references public.operacional_reservas (id) on delete set null,
  conversa_id uuid references public.comunicacao_conversas (id) on delete set null,
  hospede_id uuid references public.operacional_hospedes (id) on delete set null,
  proposito text not null
    check (proposito in ('fnrh_links', 'senha_acesso', 'chat_operador', 'generico')),
  canal text not null
    check (canal in ('whatsapp', 'email')),
  destinatario_mascara text,
  corpo_preview text,
  status text not null
    check (status in ('simulado', 'enviada', 'falha')),
  provider text not null
    check (provider in ('digisac_stub', 'digisac', 'resend')),
  provider_message_id text,
  metadata jsonb,
  erro text,
  created_at timestamptz not null default now()
);

create index if not exists operacional_comunicacao_envios_reserva_id_idx
  on public.operacional_comunicacao_envios (reserva_id, created_at desc);
create index if not exists operacional_comunicacao_envios_conversa_id_idx
  on public.operacional_comunicacao_envios (conversa_id, created_at desc);

alter table public.operacional_comunicacao_envios enable row level security;

create policy operacional_comunicacao_envios_select
  on public.operacional_comunicacao_envios
  for select
  to authenticated
  using (true);
