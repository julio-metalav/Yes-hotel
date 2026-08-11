-- PPD: bloquear autorização se já existir cobrança Pagar.me paid na reserva.
-- Fail-closed no banco — impede bypass via update direto no client.

create or replace function public.trg_ppd_block_when_pagarme_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Só intercepta a transição false → true de autorização PPD.
  if coalesce(new.pagamento_presencial_diferido_autorizado, false) = true
     and coalesce(old.pagamento_presencial_diferido_autorizado, false) = false then
    if exists (
      select 1
      from public.operacional_cobrancas_pagarme c
      where c.reserva_id = new.id
        and lower(c.status) = 'paid'
    ) then
      raise exception 'ppd_bloqueado_pagarme_pago'
        using errcode = 'P0001',
              hint = 'Cobrança Pagar.me já paid — pagamento presencial diferido não é elegível.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ppd_block_when_pagarme_paid on public.operacional_reservas;

create trigger trg_ppd_block_when_pagarme_paid
  before update of pagamento_presencial_diferido_autorizado
  on public.operacional_reservas
  for each row
  execute function public.trg_ppd_block_when_pagarme_paid();

comment on function public.trg_ppd_block_when_pagarme_paid() is
  'Bloqueia autorização de pagamento presencial diferido quando existe cobrança Pagar.me paid na reserva.';
