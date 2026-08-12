-- FNRH check-in digital v2 (PR4 conectado)
-- Escopo: colunas de ficha v2, menor, bucket privado, document_type cnh.
-- Sem backfill de guest_role. Sem alterar TTLock/Pagar.me/PPD.

-- ---------------------------------------------------------------------------
-- A. fnrh_hospedes — identidade / endereço / viagem / aceite / prova / flags
-- ---------------------------------------------------------------------------
alter table public.fnrh_hospedes
  add column if not exists nome_social text,
  add column if not exists sexo text
    check (sexo is null or sexo in ('M', 'F', 'outro', 'nao_informado')),
  add column if not exists documento_tipo text
    check (
      documento_tipo is null
      or documento_tipo in (
        'cpf',
        'rg',
        'cnh',
        'passport',
        'birth_certificate',
        'other'
      )
    ),
  add column if not exists documento_numero text,
  add column if not exists orgao_emissor text,
  add column if not exists pais_emissor text,
  add column if not exists documento_validade date,
  add column if not exists cep text,
  add column if not exists logradouro text,
  add column if not exists numero text,
  add column if not exists complemento text,
  add column if not exists bairro text,
  add column if not exists cidade text,
  add column if not exists uf text,
  add column if not exists pais text,
  add column if not exists endereco_estrangeiro text,
  add column if not exists motivo_viagem text,
  add column if not exists meio_transporte text,
  add column if not exists terms_version text,
  add column if not exists privacy_notice_version text,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists data_confirmed boolean not null default false,
  add column if not exists privacy_accepted boolean not null default false,
  add column if not exists confirmation_snapshot jsonb,
  add column if not exists snapshot_hash text,
  add column if not exists hash_algorithm text,
  add column if not exists schema_version text,
  add column if not exists confirmed_ip text,
  add column if not exists confirmed_user_agent text,
  add column if not exists field_provenance jsonb not null default '{}'::jsonb,
  add column if not exists identity_verification_status text not null default 'not_required'
    check (
      identity_verification_status in (
        'not_required',
        'pending',
        'passed',
        'failed',
        'skipped'
      )
    ),
  add column if not exists document_verification_status text not null default 'not_required'
    check (
      document_verification_status in (
        'not_required',
        'pending',
        'passed',
        'failed',
        'skipped'
      )
    ),
  add column if not exists face_verification_status text not null default 'not_required'
    check (
      face_verification_status in (
        'not_required',
        'pending',
        'passed',
        'failed',
        'skipped'
      )
    ),
  add column if not exists flow_version text not null default 'legacy'
    check (flow_version in ('legacy', 'v2')),
  add column if not exists minor_relation text
    check (
      minor_relation is null
      or minor_relation in (
        'pai',
        'mae',
        'tutor_responsavel_legal',
        'outro'
      )
    ),
  add column if not exists minor_relation_other text,
  add column if not exists minor_accompaniment text
    check (
      minor_accompaniment is null
      or minor_accompaniment in (
        'acompanhado_por_pai_mae',
        'acompanhado_por_responsavel_legal',
        'acompanhado_por_terceiro_autorizado'
      )
    );

comment on column public.fnrh_hospedes.flow_version is
  'legacy = canvas/assinatura; v2 = check-in digital (documento + aceite versionado).';
comment on column public.fnrh_hospedes.confirmation_snapshot is
  'Snapshot determinístico no confirm v2 (sem blob de imagem).';
comment on column public.fnrh_hospedes.snapshot_hash is
  'SHA-256 do confirmation_snapshot canônico.';
comment on column public.fnrh_hospedes.field_provenance is
  'Proveniência leve por campo: manual|ocr|hits|legacy.';
comment on column public.fnrh_hospedes.minor_relation is
  'Relação do responsável com o menor (dado da ficha).';

create index if not exists fnrh_hospedes_flow_version_idx
  on public.fnrh_hospedes (flow_version);

create index if not exists fnrh_hospedes_snapshot_hash_idx
  on public.fnrh_hospedes (snapshot_hash)
  where snapshot_hash is not null;

-- ---------------------------------------------------------------------------
-- B. operacional_fnrh_documentos — tipos adicionais (cnh) sem quebrar check
-- ---------------------------------------------------------------------------
alter table public.operacional_fnrh_documentos
  drop constraint if exists operacional_fnrh_documentos_document_type_check;

alter table public.operacional_fnrh_documentos
  add constraint operacional_fnrh_documentos_document_type_check
  check (
    document_type in (
      'cpf',
      'rg',
      'cnh',
      'passport',
      'birth_certificate',
      'travel_authorization',
      'other'
    )
  );

-- ---------------------------------------------------------------------------
-- C. Storage — bucket privado fnrh-documents (fail-closed)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'fnrh-documents',
  'fnrh-documents',
  false,
  10485760,
  array[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'application/pdf'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Sem INSERT/UPDATE/DELETE para authenticated/anon (service_role bypassa RLS).
drop policy if exists fnrh_documents_select_ops on storage.objects;
create policy fnrh_documents_select_ops
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'fnrh-documents'
    and public.is_yes_hotel_ops_reader()
  );

comment on table public.fnrh_hospedes is
  'Ficha FNRH por hóspede. v2: documento em storage + aceite versionado + snapshot_hash.';
