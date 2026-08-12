-- Campos comerciais/financeiros HITS em operacional_reservas (persistência mínima).
-- Nomes alinhados ao DTO HITS / domínio Yes Hotel.
-- Não altera RLS; sync service_role continua gravando classificação via hits_campo.

begin;

alter table public.operacional_reservas
  add column if not exists channel_manager text,
  add column if not exists sales_channel text,
  add column if not exists billing_entity text,
  add column if not exists reservation_channel_id text,
  add column if not exists reservation_balance_due numeric(14, 2),
  add column if not exists reservation_total_amount numeric(14, 2);

comment on column public.operacional_reservas.channel_manager is
  'Gestor de canal HITS (ex.: integrator / B2BRESERVAS / Omnibees). Texto de exibição.';
comment on column public.operacional_reservas.sales_channel is
  'Canal de vendas/origem HITS (ex.: Booking, tunibraco, Motor de Reservas).';
comment on column public.operacional_reservas.billing_entity is
  'Empresa/solicitante de faturamento HITS (companyName ou requesterCompanyName).';
comment on column public.operacional_reservas.reservation_channel_id is
  'reservationChannelId HITS quando disponível (código estável para classificação futura).';
comment on column public.operacional_reservas.reservation_balance_due is
  'Saldo pendente oficial HITS (reservationBalanceDue). Fonte da quitação.';
comment on column public.operacional_reservas.reservation_total_amount is
  'Valor total oficial HITS (reservationTotalAmount).';

commit;
