-- Cada linha em operacional_hospedes ganha automaticamente registro em fnrh_hospedes (link_token único).
-- Garante que send-fnrh-links tenha pendentes após importação/painel sem passo manual extra.

create or replace function public.operacional_hospedes_criar_fnrh()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.fnrh_hospedes (reserva_id, hospede_id, link_token, hospede_nome)
  values (
    new.reserva_id,
    new.id,
    encode(extensions.gen_random_bytes(24), 'hex'),
    coalesce(nullif(trim(new.nome), ''), 'Hóspede')
  )
  on conflict (reserva_id, hospede_id) do nothing;
  return new;
end;
$$;

drop trigger if exists operacional_hospedes_criar_fnrh on public.operacional_hospedes;
create trigger operacional_hospedes_criar_fnrh
  after insert on public.operacional_hospedes
  for each row
  execute function public.operacional_hospedes_criar_fnrh();

comment on function public.operacional_hospedes_criar_fnrh() is
  'Cria fnrh_hospedes pendente para cada hóspede inserido (importação, painel, etc.).';

-- Retroativo: hóspedes sem FNRH
insert into public.fnrh_hospedes (reserva_id, hospede_id, link_token, hospede_nome)
select
  h.reserva_id,
  h.id,
  encode(extensions.gen_random_bytes(24), 'hex'),
  coalesce(nullif(trim(h.nome), ''), 'Hóspede')
from public.operacional_hospedes h
where not exists (select 1 from public.fnrh_hospedes f where f.hospede_id = h.id)
on conflict (reserva_id, hospede_id) do nothing;


