-- =============================================================================
-- Yes Hotel — RPC atômica para criar tolerância + 3 itens
-- Migration LOCAL: NÃO aplicar neste PR3 (depende de 0022, também não aplicada).
--
-- Sem esta RPC, o client Supabase JS não garante transação multi-tabela.
-- createTolerance do adapter chama somente esta função — sem fallback multi-insert.
-- =============================================================================

begin;

create or replace function public.yes_hotel_create_access_tolerance(
  p_reservation_id uuid,
  p_credential_id uuid,
  p_first_room_access_at timestamptz,
  p_grace_started_at timestamptz,
  p_suspension_due_at timestamptz,
  p_pending_payment_at_start boolean,
  p_pending_fnrh_at_start boolean,
  p_pending_snapshot jsonb,
  p_original_valid_from timestamptz,
  p_original_valid_until timestamptz,
  p_welcome_message_event_id uuid,
  p_items jsonb
)
returns public.operacional_acesso_tolerancias
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tol public.operacional_acesso_tolerancias;
  v_item jsonb;
  v_count integer;
begin
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items deve ser array JSON';
  end if;

  select jsonb_array_length(p_items) into v_count;
  if v_count is distinct from 3 then
    raise exception 'Tolerância exige exatamente 3 itens; recebido %', coalesce(v_count, 0);
  end if;

  insert into public.operacional_acesso_tolerancias (
    reservation_id,
    credential_id,
    first_room_access_at,
    grace_started_at,
    suspension_due_at,
    grace_status,
    pending_payment_at_start,
    pending_fnrh_at_start,
    current_payment_pending,
    current_fnrh_pending,
    pending_snapshot,
    original_valid_from,
    original_valid_until,
    welcome_message_event_id
  ) values (
    p_reservation_id,
    p_credential_id,
    p_first_room_access_at,
    p_grace_started_at,
    p_suspension_due_at,
    'active',
    p_pending_payment_at_start,
    p_pending_fnrh_at_start,
    p_pending_payment_at_start,
    p_pending_fnrh_at_start,
    coalesce(p_pending_snapshot, '[]'::jsonb),
    p_original_valid_from,
    p_original_valid_until,
    p_welcome_message_event_id
  )
  returning * into v_tol;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.operacional_acesso_tolerancia_itens (
      tolerance_id,
      credential_item_id,
      logical_destination,
      lock_id,
      remote_keyboard_pwd_id,
      original_valid_from,
      original_valid_until,
      suspension_status,
      restore_status
    ) values (
      v_tol.id,
      (v_item->>'credential_item_id')::uuid,
      v_item->>'logical_destination',
      (v_item->>'lock_id')::bigint,
      (v_item->>'remote_keyboard_pwd_id')::bigint,
      p_original_valid_from,
      p_original_valid_until,
      'pending',
      'not_applicable'
    );
  end loop;

  return v_tol;
end;
$$;

comment on function public.yes_hotel_create_access_tolerance is
  'Cria tolerância + 3 itens em uma única transação. Service role / Edge only.';

revoke all on function public.yes_hotel_create_access_tolerance(
  uuid, uuid, timestamptz, timestamptz, timestamptz,
  boolean, boolean, jsonb, timestamptz, timestamptz, uuid, jsonb
) from public;

grant execute on function public.yes_hotel_create_access_tolerance(
  uuid, uuid, timestamptz, timestamptz, timestamptz,
  boolean, boolean, jsonb, timestamptz, timestamptz, uuid, jsonb
) to service_role;

commit;
