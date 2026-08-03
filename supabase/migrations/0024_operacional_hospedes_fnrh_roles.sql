-- =============================================================================
-- Yes Hotel PR4 — papéis de hóspede, ciclo formal FNRH, documentos e auditoria
-- Migration LOCAL: NÃO aplicar neste PR (0022/0023 também ainda não aplicadas).
--
-- Estratégia de compatibilidade:
-- - NÃO remove/renomeia operacional_hospedes.principal nem fnrh_hospedes.status.
-- - Colunas novas nullable para legado; guest_role null/legacy_unclassified
--   exige classificação antes de declarar reserva completa.
-- - fnrh_lifecycle_status é o estado formal PR4; status legado permanece.
-- =============================================================================

begin;

-- Helper de leitura ops (idempotente; também definido em 0022).
create or replace function public.is_yes_hotel_ops_reader()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.usuarios_internos u
    where u.auth_user_id = auth.uid()
      and u.ativo = true
      and lower(u.perfil_usuario) in ('admin', 'recepcao')
  );
$$;

-- ---------------------------------------------------------------------------
-- A. Papel do hóspede em operacional_hospedes
-- ---------------------------------------------------------------------------
alter table public.operacional_hospedes
  add column if not exists guest_role text
    check (
      guest_role is null
      or guest_role in (
        'primary_adult',
        'adult_companion',
        'minor',
        'legacy_unclassified'
      )
    ),
  add column if not exists is_minor boolean,
  add column if not exists responsible_guest_id uuid
    references public.operacional_hospedes (id) on delete set null,
  add column if not exists requires_individual_confirmation boolean,
  add column if not exists requires_contact_channel boolean,
  add column if not exists fnrh_required boolean not null default true,
  add column if not exists inherited_address_from_guest_id uuid
    references public.operacional_hospedes (id) on delete set null,
  add column if not exists declared_by_guest_id uuid
    references public.operacional_hospedes (id) on delete set null,
  add column if not exists requires_classification boolean not null default true,
  add column if not exists removed_from_reservation boolean not null default false,
  add column if not exists data_nascimento date;

comment on column public.operacional_hospedes.guest_role is
  'Papel formal PR4. null/legacy_unclassified = legado sem classificação segura.';
comment on column public.operacional_hospedes.responsible_guest_id is
  'Responsável adulto (mesma reserva) quando guest_role=minor.';
comment on column public.operacional_hospedes.principal is
  'LEGADO: boolean de titular. Mantido para UI/Edges; preferir guest_role.';

-- Flags derivadas consistentes com o papel (quando classificado).
create or replace function public.operacional_hospedes_sync_role_flags()
returns trigger
language plpgsql
as $$
begin
  if new.guest_role = 'primary_adult' then
    new.is_minor := false;
    new.requires_individual_confirmation := coalesce(new.requires_individual_confirmation, true);
    new.requires_contact_channel := coalesce(new.requires_contact_channel, true);
    new.requires_classification := false;
    new.responsible_guest_id := null;
    new.principal := true;
  elsif new.guest_role = 'adult_companion' then
    new.is_minor := false;
    new.requires_individual_confirmation := coalesce(new.requires_individual_confirmation, true);
    new.requires_contact_channel := coalesce(new.requires_contact_channel, true);
    new.requires_classification := false;
    new.principal := false;
  elsif new.guest_role = 'minor' then
    new.is_minor := true;
    new.requires_individual_confirmation := false;
    new.requires_contact_channel := false;
    new.requires_classification := false;
    new.principal := false;
  elsif new.guest_role is null or new.guest_role = 'legacy_unclassified' then
    new.requires_classification := true;
  end if;

  if new.guest_role = 'primary_adult' and new.is_minor is true then
    raise exception 'primary_adult não pode ser menor (hospede %)', new.id;
  end if;
  if new.guest_role = 'adult_companion' and new.is_minor is true then
    raise exception 'adult_companion não pode ser menor (hospede %)', new.id;
  end if;
  if new.guest_role = 'minor' and new.responsible_guest_id is null then
    raise exception 'minor exige responsible_guest_id (hospede %)', new.id;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists operacional_hospedes_sync_role_flags_trg on public.operacional_hospedes;
create trigger operacional_hospedes_sync_role_flags_trg
  before insert or update of guest_role, is_minor, responsible_guest_id,
    requires_individual_confirmation, requires_contact_channel, principal
  on public.operacional_hospedes
  for each row
  execute function public.operacional_hospedes_sync_role_flags();

-- Validação cross-row: responsável mesma reserva + adulto.
create or replace function public.operacional_hospedes_validate_responsible()
returns trigger
language plpgsql
as $$
declare
  v_resp public.operacional_hospedes%rowtype;
begin
  if new.guest_role is distinct from 'minor' then
    return new;
  end if;
  if new.responsible_guest_id is null then
    raise exception 'minor exige responsible_guest_id';
  end if;
  if new.responsible_guest_id = new.id then
    raise exception 'responsável não pode ser o próprio menor';
  end if;

  select * into v_resp
  from public.operacional_hospedes
  where id = new.responsible_guest_id;

  if not found then
    raise exception 'responsável % não encontrado', new.responsible_guest_id;
  end if;
  if v_resp.reserva_id is distinct from new.reserva_id then
    raise exception 'responsável deve pertencer à mesma reserva';
  end if;
  if v_resp.guest_role = 'minor' or v_resp.is_minor is true then
    raise exception 'responsável deve ser adulto';
  end if;
  if v_resp.guest_role is not null
     and v_resp.guest_role not in ('primary_adult', 'adult_companion') then
    raise exception 'responsável deve ser primary_adult ou adult_companion';
  end if;
  if v_resp.removed_from_reservation is true then
    raise exception 'responsável removido da reserva não pode ser vinculado';
  end if;

  return new;
end;
$$;

drop trigger if exists operacional_hospedes_validate_responsible_trg on public.operacional_hospedes;
create trigger operacional_hospedes_validate_responsible_trg
  before insert or update of guest_role, responsible_guest_id, reserva_id
  on public.operacional_hospedes
  for each row
  execute function public.operacional_hospedes_validate_responsible();

-- No máximo um primary_adult ativo por reserva.
create unique index if not exists operacional_hospedes_one_primary_adult_uidx
  on public.operacional_hospedes (reserva_id)
  where guest_role = 'primary_adult'
    and coalesce(removed_from_reservation, false) = false;

create index if not exists operacional_hospedes_responsible_guest_id_idx
  on public.operacional_hospedes (responsible_guest_id)
  where responsible_guest_id is not null;

create index if not exists operacional_hospedes_guest_role_idx
  on public.operacional_hospedes (reserva_id, guest_role);

-- ---------------------------------------------------------------------------
-- B. Estado formal da FNRH (coluna nova; status legado preservado)
-- ---------------------------------------------------------------------------
alter table public.fnrh_hospedes
  add column if not exists fnrh_lifecycle_status text
    check (
      fnrh_lifecycle_status is null
      or fnrh_lifecycle_status in (
        'draft',
        'awaiting_guest_confirmation',
        'awaiting_responsible_confirmation',
        'under_review',
        'completed',
        'manually_completed',
        'waived',
        'cancelled'
      )
    ),
  add column if not exists completed_at timestamptz,
  add column if not exists completed_by_guest_id uuid
    references public.operacional_hospedes (id) on delete set null,
  add column if not exists completed_by_user_id uuid,
  add column if not exists confirmation_source text
    check (
      confirmation_source is null
      or confirmation_source in ('guest', 'responsible', 'reception', 'migration')
    ),
  add column if not exists confirmation_token_ref text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by_user_id uuid,
  add column if not exists review_reason text,
  add column if not exists manual_completion_reason text,
  add column if not exists waived_reason text,
  add column if not exists status_changed_at timestamptz,
  add column if not exists has_required_core_fields boolean,
  add column if not exists has_required_documents boolean;

comment on column public.fnrh_hospedes.fnrh_lifecycle_status is
  'Estado formal PR4. status (legado PT) permanece para Edges atuais.';
comment on column public.fnrh_hospedes.confirmation_token_ref is
  'Referência opaca ao token (nunca o token em claro). Preferir link_token hasheado em camada Edge.';
comment on column public.fnrh_hospedes.status is
  'LEGADO PT-BR. Não usar para conclusão formal PR4; preferir fnrh_lifecycle_status.';

create or replace function public.fnrh_hospedes_validate_lifecycle()
returns trigger
language plpgsql
as $$
begin
  if new.fnrh_lifecycle_status is distinct from old.fnrh_lifecycle_status
     or (tg_op = 'INSERT' and new.fnrh_lifecycle_status is not null) then
    new.status_changed_at := coalesce(new.status_changed_at, now());
  end if;

  if new.fnrh_lifecycle_status in ('completed', 'manually_completed') then
    new.completed_at := coalesce(new.completed_at, now());
  end if;

  if new.fnrh_lifecycle_status = 'manually_completed' then
    if new.completed_by_user_id is null then
      raise exception 'manually_completed exige completed_by_user_id';
    end if;
    if coalesce(nullif(trim(new.manual_completion_reason), ''), '') = '' then
      raise exception 'manually_completed exige manual_completion_reason';
    end if;
    if new.confirmation_source is distinct from 'reception' then
      new.confirmation_source := 'reception';
    end if;
  end if;

  if new.fnrh_lifecycle_status = 'waived' then
    if coalesce(nullif(trim(new.waived_reason), ''), '') = '' then
      raise exception 'waived exige waived_reason';
    end if;
    if new.completed_by_user_id is null then
      raise exception 'waived exige completed_by_user_id (auditoria)';
    end if;
  end if;

  if new.fnrh_lifecycle_status = 'completed'
     and new.confirmation_source = 'responsible'
     and new.completed_by_guest_id is null then
    raise exception 'completed por responsible exige completed_by_guest_id';
  end if;

  if new.fnrh_lifecycle_status = 'completed'
     and new.confirmation_source = 'guest'
     and new.completed_by_guest_id is null then
    raise exception 'completed por guest exige completed_by_guest_id';
  end if;

  return new;
end;
$$;

drop trigger if exists fnrh_hospedes_validate_lifecycle_trg on public.fnrh_hospedes;
create trigger fnrh_hospedes_validate_lifecycle_trg
  before insert or update of fnrh_lifecycle_status, completed_by_guest_id,
    completed_by_user_id, confirmation_source, manual_completion_reason, waived_reason
  on public.fnrh_hospedes
  for each row
  execute function public.fnrh_hospedes_validate_lifecycle();

create index if not exists fnrh_hospedes_lifecycle_status_idx
  on public.fnrh_hospedes (fnrh_lifecycle_status);

-- ---------------------------------------------------------------------------
-- C. Documentos (referências; sem blob/OCR/biometria)
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_fnrh_documentos (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.operacional_reservas (id) on delete cascade,
  guest_id uuid not null references public.operacional_hospedes (id) on delete cascade,
  document_subject text not null
    check (document_subject in (
      'guest',
      'minor',
      'responsible',
      'travel_authorization'
    )),
  document_type text not null
    check (document_type in (
      'cpf',
      'rg',
      'passport',
      'birth_certificate',
      'travel_authorization',
      'other'
    )),
  validation_status text not null default 'pending'
    check (validation_status in (
      'pending',
      'accepted',
      'rejected',
      'needs_human_review'
    )),
  data_origin text not null default 'reception'
    check (data_origin in (
      'hits',
      'yes_hotel_history',
      'ocr',
      'guest',
      'reception'
    )),
  divergence_detected boolean not null default false,
  human_review_required boolean not null default false,
  storage_ref text,
  metadata_sanitized jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operacional_fnrh_documentos_no_blob_check check (
    storage_ref is null or length(storage_ref) <= 512
  )
);

create index if not exists operacional_fnrh_documentos_guest_id_idx
  on public.operacional_fnrh_documentos (guest_id);
create index if not exists operacional_fnrh_documentos_reservation_id_idx
  on public.operacional_fnrh_documentos (reservation_id);

comment on table public.operacional_fnrh_documentos is
  'Referências de documentos FNRH. Sem imagem/OCR/biometria inline.';

alter table public.operacional_fnrh_documentos enable row level security;

drop policy if exists operacional_fnrh_documentos_select_ops on public.operacional_fnrh_documentos;
create policy operacional_fnrh_documentos_select_ops
  on public.operacional_fnrh_documentos
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

-- Sem policies de escrita para authenticated: service_role only.

-- ---------------------------------------------------------------------------
-- D. Auditoria append-only
-- ---------------------------------------------------------------------------
create table if not exists public.operacional_fnrh_auditoria (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.operacional_reservas (id) on delete cascade,
  guest_id uuid references public.operacional_hospedes (id) on delete set null,
  event_type text not null
    check (event_type in (
      'guest_role_changed',
      'responsible_changed',
      'fnrh_confirmed',
      'fnrh_manually_completed',
      'fnrh_waived',
      'fnrh_status_changed',
      'fnrh_data_corrected',
      'guest_classification_required'
    )),
  previous_state jsonb not null default '{}'::jsonb,
  new_state jsonb not null default '{}'::jsonb,
  actor_type text not null
    check (actor_type in ('guest', 'responsible', 'reception', 'system', 'migration')),
  actor_guest_id uuid references public.operacional_hospedes (id) on delete set null,
  actor_user_id uuid,
  justification text,
  source text not null default 'backend',
  created_at timestamptz not null default now()
);

create index if not exists operacional_fnrh_auditoria_reservation_id_idx
  on public.operacional_fnrh_auditoria (reservation_id, created_at desc);
create index if not exists operacional_fnrh_auditoria_guest_id_idx
  on public.operacional_fnrh_auditoria (guest_id, created_at desc);

comment on table public.operacional_fnrh_auditoria is
  'Trilha append-only FNRH. Sem tokens, fotos, senhas ou documentos completos.';

alter table public.operacional_fnrh_auditoria enable row level security;

drop policy if exists operacional_fnrh_auditoria_select_ops on public.operacional_fnrh_auditoria;
create policy operacional_fnrh_auditoria_select_ops
  on public.operacional_fnrh_auditoria
  for select
  to authenticated
  using (public.is_yes_hotel_ops_reader());

-- Impedir update/delete por authenticated (append-only via service_role).
-- service_role bypassa RLS — reforço com trigger que bloqueia UPDATE/DELETE para todos.
create or replace function public.operacional_fnrh_auditoria_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'operacional_fnrh_auditoria é append-only: UPDATE/DELETE proibidos';
end;
$$;

drop trigger if exists operacional_fnrh_auditoria_no_update_trg on public.operacional_fnrh_auditoria;
create trigger operacional_fnrh_auditoria_no_update_trg
  before update on public.operacional_fnrh_auditoria
  for each row
  execute function public.operacional_fnrh_auditoria_append_only();

drop trigger if exists operacional_fnrh_auditoria_no_delete_trg on public.operacional_fnrh_auditoria;
create trigger operacional_fnrh_auditoria_no_delete_trg
  before delete on public.operacional_fnrh_auditoria
  for each row
  execute function public.operacional_fnrh_auditoria_append_only();

-- ---------------------------------------------------------------------------
-- E. View de lacunas de classificação (somente leitura; sem alterar dados)
-- ---------------------------------------------------------------------------
create or replace view public.operacional_fnrh_classification_gaps
with (security_invoker = true)
as
select
  h.reserva_id,
  h.id as guest_id,
  h.guest_role,
  h.requires_classification,
  h.responsible_guest_id,
  h.is_minor,
  h.removed_from_reservation,
  f.fnrh_lifecycle_status,
  f.status as legacy_status,
  case
    when h.guest_role is null or h.guest_role = 'legacy_unclassified' then 'unclassified_guest'
    when h.guest_role = 'minor' and h.responsible_guest_id is null then 'minor_without_responsible'
    when h.requires_contact_channel is true
         and coalesce(nullif(trim(h.whatsapp), ''), '') = ''
         and coalesce(nullif(trim(h.email), ''), '') = '' then 'adult_without_contact'
    when f.fnrh_lifecycle_status in ('completed', 'manually_completed')
         and f.completed_by_guest_id is null
         and f.completed_by_user_id is null then 'completed_without_actor'
    when f.fnrh_lifecycle_status = 'manually_completed'
         and coalesce(nullif(trim(f.manual_completion_reason), ''), '') = '' then 'manual_without_reason'
    else null
  end as gap_code
from public.operacional_hospedes h
left join public.fnrh_hospedes f
  on f.hospede_id = h.id and f.reserva_id = h.reserva_id;

comment on view public.operacional_fnrh_classification_gaps is
  'Diagnóstico de classificação FNRH. Não altera dados. PR4: somente consulta.';

-- Contagem de múltiplos principais legados (principal boolean) vs formal.
create or replace view public.operacional_fnrh_duplicate_primary_gaps
with (security_invoker = true)
as
select
  reserva_id,
  count(*) filter (where guest_role = 'primary_adult' and coalesce(removed_from_reservation, false) = false) as formal_primary_count,
  count(*) filter (where principal = true and coalesce(removed_from_reservation, false) = false) as legacy_principal_count
from public.operacional_hospedes
group by reserva_id
having
  count(*) filter (where guest_role = 'primary_adult' and coalesce(removed_from_reservation, false) = false) > 1
  or count(*) filter (where principal = true and coalesce(removed_from_reservation, false) = false) > 1;

-- ---------------------------------------------------------------------------
-- F. RLS / proteção: impedir alteração direta de status formal pelo frontend
-- ---------------------------------------------------------------------------
-- Confirmação pública continua via Edge/RPC com token (não policy ampla).
-- service_role / postgres podem escrever lifecycle; authenticated não.

create or replace function public.fnrh_hospedes_block_frontend_lifecycle_write()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    if tg_op = 'UPDATE' then
      if new.fnrh_lifecycle_status is distinct from old.fnrh_lifecycle_status
         or new.completed_by_guest_id is distinct from old.completed_by_guest_id
         or new.completed_by_user_id is distinct from old.completed_by_user_id
         or new.confirmation_source is distinct from old.confirmation_source
         or new.manual_completion_reason is distinct from old.manual_completion_reason
         or new.waived_reason is distinct from old.waived_reason
         or new.completed_at is distinct from old.completed_at
         or new.confirmation_token_ref is distinct from old.confirmation_token_ref
      then
        raise exception
          'Alteração de lifecycle/ator/justificativa FNRH só via backend (service_role/Edge).';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists fnrh_hospedes_block_frontend_lifecycle_trg on public.fnrh_hospedes;
create trigger fnrh_hospedes_block_frontend_lifecycle_trg
  before update on public.fnrh_hospedes
  for each row
  execute function public.fnrh_hospedes_block_frontend_lifecycle_write();

create or replace function public.operacional_hospedes_block_frontend_role_write()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') = 'authenticated' then
    if tg_op = 'UPDATE' then
      if new.guest_role is distinct from old.guest_role
         or new.responsible_guest_id is distinct from old.responsible_guest_id
         or new.requires_classification is distinct from old.requires_classification
         or new.is_minor is distinct from old.is_minor
      then
        raise exception
          'Alteração de guest_role/responsável só via backend (service_role/Edge).';
      end if;
    elsif tg_op = 'INSERT' then
      if new.guest_role is not null
         and new.guest_role is distinct from 'legacy_unclassified' then
        raise exception
          'Classificação formal de guest_role no INSERT só via backend (service_role/Edge).';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists operacional_hospedes_block_frontend_role_trg on public.operacional_hospedes;
create trigger operacional_hospedes_block_frontend_role_trg
  before insert or update on public.operacional_hospedes
  for each row
  execute function public.operacional_hospedes_block_frontend_role_write();

commit;
