-- Marco temporal: quando a reserva atingiu FNRH agregado completo (base para régua do envio automático da senha).

alter table public.operacional_reservas
    add column if not exists fnrh_completo_em timestamptz;
comment on column public.operacional_reservas.fnrh_completo_em is
    'Primeiro instante em que fnrh_status_agregado passou a fnrh_completo; usado com check-in para calcular envio automático da senha (24h antes ou imediato se validação tardia).';
-- Retrocompatível: reservas já completas sem marco recebem updated_at como aproximação.
update public.operacional_reservas
set fnrh_completo_em = coalesce(fnrh_completo_em, updated_at)
where fnrh_status_agregado = 'fnrh_completo'
  and fnrh_completo_em is null;
