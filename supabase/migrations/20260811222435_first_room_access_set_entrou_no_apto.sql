-- Atomically mark first room access on reservation inside yes_hotel_process_first_room_access.
-- Modelo vigente: operacional_reservas.entrou_no_apto + timestamp canonico =
--   - processed_no_pending: operacional_acesso_eventos.occurred_at (retornado como first_access_at)
--   - grace_started: operacional_acesso_tolerancias.first_room_access_at
-- Coluna primeiro_acesso_em NAO existe no schema fisico atual — nao inventar.
-- Preserva idempotencia e fail-closed.

create or replace function public.yes_hotel_process_first_room_access(
  p_decision text,
  p_source text,
  p_source_event_id text,
  p_idempotency_key text,
  p_occurred_at timestamptz,
  p_received_at timestamptz,
  p_lock_id bigint,
  p_keyboard_pwd_id bigint,
  p_record_type integer,
  p_access_method text,
  p_success boolean,
  p_reservation_id uuid,
  p_credential_id uuid,
  p_credential_item_id uuid,
  p_logical_destination text,
  p_raw_payload_sanitized jsonb,
  p_ignored_reason text,
  p_first_room_access_at timestamptz,
  p_grace_started_at timestamptz,
  p_suspension_due_at timestamptz,
  p_pending_payment boolean,
  p_pending_fnrh boolean,
  p_pending_snapshot jsonb,
  p_original_valid_from timestamptz,
  p_original_valid_until timestamptz,
  p_items jsonb,
  p_outbox_event jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_existing public.operacional_acesso_eventos;
  v_tol public.operacional_acesso_tolerancias;
  v_event public.operacional_acesso_eventos;
  v_item jsonb;
  v_count integer;
  v_class text;
  v_classes text[] := array[]::text[];
  v_outbox_id uuid;
  v_cred_reserva uuid;
  v_item_row public.operacional_credencial_itens;
  v_grace_mode text := 'standard_1h';
  v_ppd boolean := false;
  v_already_entered boolean := false;
begin
  if p_decision not in ('ignored', 'processed_no_pending', 'grace_started', 'already_started') then
    raise exception 'decision inválida: %', p_decision;
  end if;

  perform public.yes_hotel_assert_payload_sanitized(
    coalesce(p_raw_payload_sanitized, '{}'::jsonb),
    'raw_payload_sanitized'
  );

  if p_outbox_event is not null then
    perform public.yes_hotel_assert_payload_sanitized(p_outbox_event, 'outbox_event');
    perform public.yes_hotel_assert_payload_sanitized(
      coalesce(p_outbox_event->'payload', '{}'::jsonb),
      'outbox_payload'
    );
  end if;

  select * into v_existing
  from public.operacional_acesso_eventos
  where idempotency_key = p_idempotency_key
     or (source = p_source and source_event_id = p_source_event_id)
  limit 1;

  if found then
    if v_existing.credential_id is not null then
      select * into v_tol
      from public.operacional_acesso_tolerancias
      where credential_id = v_existing.credential_id;
    end if;

    if v_existing.processing_status = 'ignored' then
      return jsonb_build_object(
        'status', 'ignored',
        'event_id', v_existing.id,
        'ignored_reason', coalesce(v_existing.ignored_reason, 'duplicate'),
        'idempotent', true
      );
    end if;

    if v_tol.id is not null then
      return jsonb_build_object(
        'status', 'already_started',
        'event_id', v_existing.id,
        'tolerance_id', v_tol.id,
        'suspension_due_at', v_tol.suspension_due_at,
        'pending_reasons', coalesce(v_tol.pending_snapshot, '[]'::jsonb),
        'idempotent', true
      );
    end if;

    if v_existing.processing_status = 'processed' then
      return jsonb_build_object(
        'status', 'processed_no_pending',
        'event_id', v_existing.id,
        'idempotent', true
      );
    end if;

    return jsonb_build_object(
      'status', 'already_started',
      'event_id', v_existing.id,
      'idempotent', true
    );
  end if;

  insert into public.operacional_acesso_eventos (
    source, source_event_id, idempotency_key,
    occurred_at, received_at, lock_id, keyboard_pwd_id,
    record_type, access_method, success,
    reservation_id, credential_id, credential_item_id, logical_destination,
    processing_status, raw_payload_sanitized
  ) values (
    p_source, p_source_event_id, p_idempotency_key,
    p_occurred_at, coalesce(p_received_at, now()), p_lock_id, p_keyboard_pwd_id,
    p_record_type, p_access_method, p_success,
    p_reservation_id, p_credential_id, p_credential_item_id, p_logical_destination,
    'received', p_raw_payload_sanitized
  )
  returning * into v_event;

  if p_decision = 'ignored' then
    update public.operacional_acesso_eventos
    set processing_status = 'ignored',
        ignored_reason = coalesce(p_ignored_reason, 'ignored'),
        processed_at = now()
    where id = v_event.id;

    if p_outbox_event is not null and p_reservation_id is not null then
      insert into public.operacional_acesso_outbox (
        event_type, channel, reservation_id, credential_id, access_event_id,
        recipient_ref, template, payload, idempotency_key, status, available_at
      ) values (
        coalesce(p_outbox_event->>'event_type', 'internal_alert'),
        coalesce(p_outbox_event->>'channel', 'whatsapp'),
        p_reservation_id,
        p_credential_id,
        v_event.id,
        p_outbox_event->>'recipient_ref',
        p_outbox_event->>'template',
        coalesce(p_outbox_event->'payload', '{}'::jsonb),
        p_outbox_event->>'idempotency_key',
        'pending',
        coalesce((p_outbox_event->>'available_at')::timestamptz, now())
      )
      on conflict (idempotency_key) do nothing;
    end if;

    return jsonb_build_object(
      'status', 'ignored',
      'event_id', v_event.id,
      'ignored_reason', coalesce(p_ignored_reason, 'ignored')
    );
  end if;

  if p_decision = 'already_started' then
    select * into v_tol
    from public.operacional_acesso_tolerancias
    where credential_id = p_credential_id;

    update public.operacional_acesso_eventos
    set processing_status = 'ignored',
        ignored_reason = coalesce(p_ignored_reason, 'already_started'),
        processed_at = now()
    where id = v_event.id;

    return jsonb_build_object(
      'status', 'already_started',
      'event_id', v_event.id,
      'tolerance_id', v_tol.id,
      'suspension_due_at', v_tol.suspension_due_at,
      'pending_reasons', coalesce(v_tol.pending_snapshot, '[]'::jsonb),
      'ignored_reason', coalesce(p_ignored_reason, 'already_started')
    );
  end if;

  if p_decision = 'processed_no_pending' then
    if p_reservation_id is null then
      raise exception 'processed_no_pending exige reservation_id';
    end if;

    select entrou_no_apto into v_already_entered
    from public.operacional_reservas
    where id = p_reservation_id;
    if not found then
      raise exception 'reservation_id inexistente';
    end if;
    if coalesce(v_already_entered, false) then
      update public.operacional_acesso_eventos
      set processing_status = 'ignored',
          ignored_reason = 'already_started',
          processed_at = now()
      where id = v_event.id;

      return jsonb_build_object(
        'status', 'already_started',
        'event_id', v_event.id,
        'ignored_reason', 'already_started',
        'first_access_at', (
          select e.occurred_at
          from public.operacional_acesso_eventos e
          where e.reservation_id = p_reservation_id
            and e.processing_status = 'processed'
            and public.yes_hotel_classify_access_destination(e.logical_destination) = 'apartamento'
          order by e.occurred_at asc
          limit 1
        )
      );
    end if;

    update public.operacional_acesso_eventos
    set processing_status = 'processed',
        processed_at = now(),
        ignored_reason = null
    where id = v_event.id;

    update public.operacional_reservas
    set entrou_no_apto = true,
        updated_at = now()
    where id = p_reservation_id
      and entrou_no_apto is distinct from true;

    return jsonb_build_object(
      'status', 'processed_no_pending',
      'event_id', v_event.id,
      'pending_reasons', '[]'::jsonb,
      'first_access_at', p_occurred_at
    );
  end if;

  if p_reservation_id is null or p_credential_id is null then
    raise exception 'grace_started exige reservation_id e credential_id';
  end if;

  select reserva_id into v_cred_reserva
  from public.operacional_credenciais_acesso
  where id = p_credential_id;
  if not found then
    raise exception 'credential_id inexistente';
  end if;
  if v_cred_reserva is distinct from p_reservation_id then
    raise exception 'reservation_id incompatível com credential_id';
  end if;

  select entrou_no_apto into v_already_entered
  from public.operacional_reservas
  where id = p_reservation_id;
  if coalesce(v_already_entered, false) then
    update public.operacional_acesso_eventos
    set processing_status = 'ignored',
        ignored_reason = 'already_started',
        processed_at = now()
    where id = v_event.id;

    return jsonb_build_object(
      'status', 'already_started',
      'event_id', v_event.id,
      'ignored_reason', 'already_started'
    );
  end if;

  select * into v_tol
  from public.operacional_acesso_tolerancias
  where credential_id = p_credential_id;
  if found then
    update public.operacional_acesso_eventos
    set processing_status = 'ignored',
        ignored_reason = 'already_started',
        processed_at = now()
    where id = v_event.id;

    return jsonb_build_object(
      'status', 'already_started',
      'event_id', v_event.id,
      'tolerance_id', v_tol.id,
      'suspension_due_at', v_tol.suspension_due_at,
      'pending_reasons', coalesce(v_tol.pending_snapshot, '[]'::jsonb),
      'ignored_reason', 'already_started'
    );
  end if;

  if coalesce(p_pending_payment, false) is false and coalesce(p_pending_fnrh, false) is false then
    raise exception 'grace_started exige pendência real (pagamento ou FNRH)';
  end if;

  if p_grace_started_at is null or p_suspension_due_at is null then
    raise exception 'grace timestamps obrigatórios';
  end if;

  -- PPD: deadline 09:00 do dia seguinte (<> +1h). Demais casos: +1h estrito.
  v_ppd := coalesce(p_pending_snapshot, '[]'::jsonb) @> '["pagamento_presencial_diferido"]'::jsonb;
  if v_ppd then
    if coalesce(p_pending_payment, false) is not true then
      raise exception 'pagamento_presencial_diferido exige pending_payment';
    end if;
    if p_suspension_due_at <= p_grace_started_at then
      raise exception 'suspension_due_at deve ser posterior a grace_started_at';
    end if;
    if p_suspension_due_at > p_grace_started_at + interval '48 hours' then
      raise exception 'deadline presencial diferido excede 48h';
    end if;
    v_grace_mode := 'presencial_diferido_09h';
  else
    if p_suspension_due_at is distinct from (p_grace_started_at + interval '1 hour') then
      raise exception 'suspension_due_at deve ser grace_started_at + 1 hour';
    end if;
    v_grace_mode := 'standard_1h';
  end if;

  if p_original_valid_from is null or p_original_valid_until is null then
    raise exception 'validades originais obrigatórias';
  end if;
  if p_original_valid_until <= p_original_valid_from then
    raise exception 'original_valid_until deve ser > original_valid_from';
  end if;

  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'p_items deve ser array';
  end if;
  select jsonb_array_length(p_items) into v_count;
  if v_count is distinct from 3 then
    raise exception 'Tolerância exige exatamente 3 itens; recebido %', coalesce(v_count, 0);
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_class := coalesce(
      nullif(trim(v_item->>'lock_class'), ''),
      public.yes_hotel_classify_access_destination(v_item->>'logical_destination')
    );
    if v_class not in ('apartamento', 'portao_externo', 'portao_interno') then
      raise exception 'destino lógico inválido: %', v_item->>'logical_destination';
    end if;
    if v_class = any (v_classes) then
      raise exception 'destino duplicado: %', v_class;
    end if;
    v_classes := array_append(v_classes, v_class);

    if coalesce(v_item->>'remote_keyboard_pwd_id', '') = '' then
      raise exception 'item sem remote_keyboard_pwd_id';
    end if;
    if coalesce(v_item->>'lock_id', '') = '' then
      raise exception 'item sem lock_id';
    end if;
    if coalesce(v_item->>'credential_item_id', '') = '' then
      raise exception 'item sem credential_item_id';
    end if;

    select * into v_item_row
    from public.operacional_credencial_itens
    where id = (v_item->>'credential_item_id')::uuid;
    if not found then
      raise exception 'credential_item_id inexistente';
    end if;
    if v_item_row.credencial_id is distinct from p_credential_id then
      raise exception 'item não pertence ao credential_id';
    end if;
    if v_item_row.status_provisionamento is distinct from 'provisionado' then
      raise exception 'item não está provisionado';
    end if;
    if v_item_row.remote_keyboard_pwd_id is null then
      raise exception 'item provisionado sem remote_keyboard_pwd_id no banco';
    end if;
  end loop;

  if not ('apartamento' = any (v_classes)) then
    raise exception 'apartamento ausente';
  end if;
  if not ('portao_externo' = any (v_classes)) then
    raise exception 'portão externo ausente';
  end if;
  if not ('portao_interno' = any (v_classes)) then
    raise exception 'portão interno ausente';
  end if;

  if p_outbox_event is null or coalesce(p_outbox_event->>'idempotency_key', '') = '' then
    raise exception 'grace_started exige outbox com idempotency_key';
  end if;

  insert into public.operacional_acesso_tolerancias (
    reservation_id, credential_id,
    first_room_access_at, grace_started_at, suspension_due_at,
    grace_status, grace_mode,
    pending_payment_at_start, pending_fnrh_at_start,
    current_payment_pending, current_fnrh_pending,
    pending_snapshot,
    original_valid_from, original_valid_until,
    welcome_message_event_id
  ) values (
    p_reservation_id, p_credential_id,
    coalesce(p_first_room_access_at, p_grace_started_at), p_grace_started_at, p_suspension_due_at,
    'active', v_grace_mode,
    p_pending_payment, p_pending_fnrh,
    p_pending_payment, p_pending_fnrh,
    coalesce(p_pending_snapshot, '[]'::jsonb),
    p_original_valid_from, p_original_valid_until,
    v_event.id
  )
  returning * into v_tol;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.operacional_acesso_tolerancia_itens (
      tolerance_id, credential_item_id, logical_destination, lock_id, remote_keyboard_pwd_id,
      original_valid_from, original_valid_until,
      suspension_status, restore_status
    ) values (
      v_tol.id,
      (v_item->>'credential_item_id')::uuid,
      v_item->>'logical_destination',
      (v_item->>'lock_id')::bigint,
      (v_item->>'remote_keyboard_pwd_id')::bigint,
      coalesce((v_item->>'original_valid_from')::timestamptz, p_original_valid_from),
      coalesce((v_item->>'original_valid_until')::timestamptz, p_original_valid_until),
      'pending',
      'not_applicable'
    );
  end loop;

  insert into public.operacional_acesso_outbox (
    event_type, channel, reservation_id, credential_id, access_event_id, tolerance_id,
    recipient_ref, template, payload, idempotency_key, status, available_at
  ) values (
    coalesce(p_outbox_event->>'event_type', 'guest_welcome_pending'),
    coalesce(p_outbox_event->>'channel', 'whatsapp'),
    p_reservation_id,
    p_credential_id,
    v_event.id,
    v_tol.id,
    p_outbox_event->>'recipient_ref',
    p_outbox_event->>'template',
    coalesce(p_outbox_event->'payload', '{}'::jsonb),
    p_outbox_event->>'idempotency_key',
    'pending',
    coalesce((p_outbox_event->>'available_at')::timestamptz, now())
  )
  on conflict (idempotency_key) do nothing
  returning id into v_outbox_id;

  update public.operacional_acesso_eventos
  set processing_status = 'processed',
      processed_at = now(),
      ignored_reason = null
  where id = v_event.id;

  update public.operacional_reservas
  set entrou_no_apto = true,
      updated_at = now()
  where id = p_reservation_id
    and entrou_no_apto is distinct from true;

  return jsonb_build_object(
    'status', 'grace_started',
    'event_id', v_event.id,
    'tolerance_id', v_tol.id,
    'suspension_due_at', v_tol.suspension_due_at,
    'pending_reasons', coalesce(v_tol.pending_snapshot, '[]'::jsonb),
    'outbox_id', v_outbox_id,
    'first_access_at', coalesce(p_first_room_access_at, p_grace_started_at, p_occurred_at)
  );
exception
  when unique_violation then
    select * into v_tol
    from public.operacional_acesso_tolerancias
    where credential_id = p_credential_id;
    if found then
      return jsonb_build_object(
        'status', 'already_started',
        'tolerance_id', v_tol.id,
        'suspension_due_at', v_tol.suspension_due_at,
        'pending_reasons', coalesce(v_tol.pending_snapshot, '[]'::jsonb),
        'ignored_reason', 'already_started',
        'concurrent', true
      );
    end if;
    raise;
end;
$fn$;