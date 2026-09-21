-- Perfil hits_consulta — projeção de homologação.
--
-- Objetivo: o perfil HITS vê a MESMA população de reservas da Recepção, sem os
-- dados internos da Recepção. A RPC continua sendo a única leitura do perfil
-- (nenhum GRANT em tabela, nenhuma policy nova, nenhuma escrita).
--
-- Mudanças em relação a 20260920100000:
--   * external_reservation_id — o painel une o banco à leitura do HITS por esse
--     ID (sem ele, as reservas já materializadas apareciam em duplicidade ou
--     sumiam da mesclagem);
--   * inclui reservas canceladas (a aba Chegadas da Recepção as mostra; a
--     lista operacional continua filtrando canceladas no cliente);
--   * main_guest_display_name — mesmo nome exibido pela Recepção (nome
--     social/civil confirmado na FNRH do hóspede principal; senão o original);
--   * contagens de FNRH (total de hóspedes / confirmados) e total de hóspedes
--     ativos — mesma régua de FNRH da Recepção, sem nenhum dado de hóspede;
--   * acesso_efetivo — mesma regra de "acesso liberado" da Recepção
--     (acesso_liberado OU credencial principal totalmente provisionada), só o
--     booleano: nenhum código, senha ou detalhe técnico da fechadura;
--   * manter_na_lista_operacional — decisão NEUTRA de permanência na lista
--     padrão, calculada aqui com a mesma régua da Recepção (fila operacional
--     ainda não concluída, inclusive pendência interna que o perfil não vê).
--     Só o booleano sai da função: nem o motivo, nem status, nem valores.
--
-- Continua fora: documento, contato, e-mail, telefone, valores, pagamento,
-- cobrança, comissionamento, veículo, histórico, comunicações e credenciais.
--
-- O tipo de retorno muda, então a função é recriada (drop + create) com os
-- mesmos grants: EXECUTE só para authenticated; o gate interno decide o perfil.

drop function if exists public.operacional_hits_checkin_consulta();

create function public.operacional_hits_checkin_consulta()
returns table (
  reservation_id uuid,
  external_reservation_id text,
  apartment_code text,
  main_guest_name text,
  main_guest_display_name text,
  check_in_previsto date,
  check_out_previsto date,
  status_reserva text,
  fnrh_status_agregado text,
  fnrh_hospedes_total integer,
  fnrh_hospedes_confirmados integer,
  total_hospedes integer,
  acesso_liberado boolean,
  acesso_efetivo boolean,
  entrou_no_apto boolean,
  manter_na_lista_operacional boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- SECURITY DEFINER só porque hits_consulta não tem SELECT direto nas
  -- tabelas-base; a própria função decide quem pode ler, consultando
  -- usuarios_internos por auth.uid() (nunca user_metadata/auth.jwt()).
  if not public.is_yes_hotel_hits_consulta_reader() then
    raise exception 'hits_consulta_read_forbidden_role' using errcode = '42501';
  end if;

  return query
    select
      r.id as reservation_id,
      nullif(btrim(r.external_reservation_id), '') as external_reservation_id,
      r.apartamento as apartment_code,
      r.hospede_principal as main_guest_name,
      coalesce(nome.exibicao, r.hospede_principal) as main_guest_display_name,
      r.check_in_previsto,
      r.check_out_previsto,
      r.status_reserva,
      r.fnrh_status_agregado,
      coalesce(h.total, 0)::integer as fnrh_hospedes_total,
      coalesce(h.confirmados, 0)::integer as fnrh_hospedes_confirmados,
      coalesce(h.ativos, 0)::integer as total_hospedes,
      coalesce(r.acesso_liberado, false) as acesso_liberado,
      (coalesce(r.acesso_liberado, false) or coalesce(ac.todos_provisionados, false)) as acesso_efetivo,
      coalesce(r.entrou_no_apto, false) as entrou_no_apto,
      -- Mesma decisão da Recepção (getFilaOperacionalRank < 4): FNRH, acesso,
      -- entrada ou pendência interna. Só true/false; o motivo não sai daqui.
      (
        coalesce(perm.pendencia_interna, true)
        or coalesce(h.total, 0) = 0
        or coalesce(h.confirmados, 0) < coalesce(h.total, 0)
        or not (coalesce(r.acesso_liberado, false) or coalesce(ac.todos_provisionados, false))
        or not coalesce(r.entrou_no_apto, false)
      ) as manter_na_lista_operacional
    from public.operacional_reservas r
    left join lateral (
      select
        count(*) as total,
        count(*) filter (where not coalesce(oh.removed_from_reservation, false)) as ativos,
        count(*) filter (
          where oh.status_operacional = 'confirmado'
             or exists (
               select 1
               from public.fnrh_hospedes f
               where f.hospede_id = oh.id
                 and (
                   f.status in ('confirmado_hospede', 'confirmado_hotel', 'enviado_oficial',
                                'erro_sincronizacao', 'preenchido')
                   or f.fnrh_lifecycle_status in ('completed', 'manually_completed')
                 )
             )
        ) as confirmados
      from public.operacional_hospedes oh
      where oh.reserva_id = r.id
    ) h on true
    left join lateral (
      select nullif(btrim(coalesce(nullif(btrim(f.nome_social), ''), f.hospede_nome)), '') as exibicao
      from public.operacional_hospedes p
      join public.fnrh_hospedes f on f.hospede_id = p.id
      where p.reserva_id = r.id
        and p.principal
        and (
          f.status in ('confirmado_hospede', 'confirmado_hotel', 'enviado_oficial',
                       'erro_sincronizacao', 'preenchido')
          or f.fnrh_lifecycle_status in ('completed', 'manually_completed')
        )
      order by p.created_at asc
      limit 1
    ) nome on true
    left join lateral (
      select count(*) > 0 and bool_and(itens.n > 0 and itens.ok = itens.n) as todos_provisionados
      from public.operacional_credenciais_acesso c
      left join lateral (
        select
          count(*) as n,
          count(*) filter (
            where i.status_provisionamento::text = 'provisionado'
              and i.remote_keyboard_pwd_id is not null
          ) as ok
        from public.operacional_credencial_itens i
        where i.credencial_id = c.id
      ) itens on true
      where c.reserva_id = r.id
        and c.tipo_credencial = 'principal'
        and c.status::text <> 'revogada'
    ) ac on true
    -- [permanencia:inicio] Estado interno usado SÓ para a decisão booleana de
    -- permanência (mesma regra de isFinanceiramenteLiberadoParaAcesso da
    -- Recepção). Nenhuma coluna deste bloco é devolvida ao perfil.
    left join lateral (
      select not (
        lower(btrim(coalesce(r.pagamento_status::text, ''))) = 'pago'
        or (r.reservation_balance_due is not null and r.reservation_balance_due <= 0)
        or (
          r.reservation_balance_due is not null
          and q.quitado_centavos > 0
          and q.quitado_centavos >= round(r.reservation_balance_due * 100)
        )
        or lower(btrim(coalesce(r.classificacao_comissionamento, ''))) = 'comissionada'
      ) as pendencia_interna
      from (
        select coalesce(sum(cp.valor_centavos) filter (
          where lower(cp.status) = 'paid' and cp.valor_centavos > 0
        ), 0) as quitado_centavos
        from public.operacional_cobrancas_pagarme cp
        where cp.reserva_id = r.id
      ) q
    ) perm on true
    -- [permanencia:fim]
    order by r.check_in_previsto desc;
end;
$$;

comment on function public.operacional_hits_checkin_consulta() is
  'Única fonte de leitura do perfil hits_consulta (homologação HITS). Mesma '
  'população de reservas da Recepção, só com campos operacionais: IDs, apto, '
  'nome exibido, datas, status, FNRH (agregado e contagens), acesso, entrada e '
  'a decisão neutra manter_na_lista_operacional (sem motivo). '
  'Sem documento, contato, financeiro, veículo, histórico ou credenciais. '
  'SECURITY DEFINER, search_path vazio, gate is_yes_hotel_hits_consulta_reader().';

revoke all on function public.operacional_hits_checkin_consulta() from public, anon;
grant execute on function public.operacional_hits_checkin_consulta() to authenticated;
