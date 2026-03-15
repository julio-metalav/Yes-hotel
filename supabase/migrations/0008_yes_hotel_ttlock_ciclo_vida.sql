-- Fase TTLock 3: ciclo de vida da credencial (revogação, alteração de validade, reprovisionamento).
-- Campos para rastrear revogação na credencial e motivo.

alter table public.operacional_credenciais_acesso
  add column if not exists revogado_em timestamptz,
  add column if not exists motivo_revogacao text;

comment on column public.operacional_credenciais_acesso.revogado_em is
  'Data/hora em que a credencial foi revogada (acesso removido no TTLock e estado interno atualizado).';
comment on column public.operacional_credenciais_acesso.motivo_revogacao is
  'Motivo operacional da revogação: cancelamento, checkout, room_change, ajuste_manual, etc.';
