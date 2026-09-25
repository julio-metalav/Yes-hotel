-- Café da manhã: o HITS decide QUEM está hospedado; o banco local só enriquece.
--
-- Antes, operacional_cafe_listar_hospedagens lia só operacional_reservas: reservas
-- locais antigas/fora do HITS ("fantasmas") entravam no café e reservas reais do
-- HITS ainda não materializadas ficavam de fora. Agora a população vem de
-- public.hits_reservas_snapshot (universo ativo, escrito pelo scheduler) com
-- LEFT JOIN em operacional_reservas para o enriquecimento local (id operacional,
-- meal_plan_desc, pagamento/PPD). Regra de data mantida: check_in < D <= check_out
-- (quem dormiu a noite anterior a D, inclusive quem sai em D).
--
-- Universo indisponível (snapshot nunca sincronizado ou sem sucesso há mais de
-- 6 h): a função ERRA explicitamente em vez de devolver população local antiga.
--
-- Só CREATE OR REPLACE desta RPC (mesma assinatura e mesmo tipo de retorno; só
-- reservation_id passa a poder ser NULL para reserva ainda não materializada).
-- Sem tabela nova, sem apagar nada, sem tocar atendimentos, entitlement ou
-- resolveCafeBreakfastEntitlementFromHits (meal_plan_desc continua o mesmo campo).

create or replace function public.operacional_cafe_listar_hospedagens(p_data_cafe date)
returns table (
  reservation_id uuid,
  apartment_code text,
  main_guest_name text,
  external_reservation_id text,
  check_in_previsto date,
  check_out_previsto date,
  status_reserva text,
  total_guests integer,
  meal_plan_desc text,
  pagamento_status text,
  pagamento_presencial_diferido_autorizado boolean,
  pagamento_presencial_diferido_efetivado boolean,
  pagamento_presencial_diferido_regularizado_em timestamptz,
  pagamento_presencial_diferido_bloqueado_em timestamptz,
  pagamento_presencial_diferido_deadline_em timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last_success timestamptz;
begin
  -- SECURITY DEFINER só porque cafe não tem SELECT direto nas tabelas base
  -- (nem no snapshot); a própria função decide quem pode ler, consultando
  -- usuarios_internos por auth.uid() (nunca user_metadata/auth.jwt()).
  if not public.is_yes_hotel_cafe_reader() then
    raise exception 'cafe_read_forbidden_role' using errcode = '42501';
  end if;

  if p_data_cafe is null then
    raise exception 'cafe_read_missing_date' using errcode = '22023';
  end if;

  -- Universo HITS válido: último ciclo bem-sucedido recente. Sem isso, não se
  -- ressuscita população local antiga como se fosse atual.
  select s.last_success_at into v_last_success
  from public.hits_snapshot_sync_state s
  where s.id = true;
  if v_last_success is null or v_last_success < now() - interval '6 hours' then
    raise exception 'Universo HITS indisponível: snapshot sem sincronização recente. O café não pode listar hospedagens agora.'
      using errcode = 'P0001';
  end if;

  return query
    select
      r.id as reservation_id,
      s.apartamento as apartment_code,
      coalesce(nullif(btrim(r.hospede_principal), ''), s.hospede_principal) as main_guest_name,
      s.external_reservation_id,
      s.check_in as check_in_previsto,
      s.check_out as check_out_previsto,
      s.status_reserva,
      case
        when coalesce(s.total_hospedes, 0) > 0 then s.total_hospedes
        when r.id is not null then greatest(
          1,
          (
            select count(*)::integer
            from public.operacional_hospedes h
            where h.reserva_id = r.id
              and coalesce(h.removed_from_reservation, false) = false
          )
        )
        else 1
      end as total_guests,
      r.meal_plan_desc,
      r.pagamento_status,
      r.pagamento_presencial_diferido_autorizado,
      r.pagamento_presencial_diferido_efetivado,
      r.pagamento_presencial_diferido_regularizado_em,
      r.pagamento_presencial_diferido_bloqueado_em,
      r.pagamento_presencial_diferido_deadline_em
    from public.hits_reservas_snapshot s
    left join public.operacional_reservas r
      on r.external_reservation_id = s.external_reservation_id
     and r.origem_externa = 'hits'
     and r.status_reserva <> 'cancelada'
    where s.status_reserva <> 'cancelada'
      and s.check_in < p_data_cafe
      and s.check_out >= p_data_cafe
    order by s.apartamento, s.external_reservation_id;
end;
$$;

comment on function public.operacional_cafe_listar_hospedagens(date) is
  'Hospedagens do café da data (check_in < D <= check_out) com população do snapshot HITS '
  '(universo ativo) enriquecida por operacional_reservas; reservation_id NULL quando ainda '
  'não materializada. Erra se o snapshot não tem sucesso recente. Só cafe/recepcao/admin.';

-- Grants inalterados (já definidos em 20260919120000): EXECUTE só authenticated.
revoke all on function public.operacional_cafe_listar_hospedagens(date) from public, anon;
grant execute on function public.operacional_cafe_listar_hospedagens(date) to authenticated;
