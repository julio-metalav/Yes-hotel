-- FNRH Yes: pipeline de status (rascunho/autosave → confirmação hóspede → envio oficial futuro).
-- Migra preenchido → confirmado_hospede (compatível com painel que contava preenchido).

alter table public.fnrh_hospedes drop constraint if exists fnrh_hospedes_status_check;

update public.fnrh_hospedes
set status = 'confirmado_hospede'
where status = 'preenchido';

alter table public.fnrh_hospedes
  add constraint fnrh_hospedes_status_check check (status in (
    'pendente',
    'rascunho',
    'pendente_confirmacao',
    'confirmado_hospede',
    'enviado_oficial',
    'erro_sincronizacao'
  ));

comment on column public.fnrh_hospedes.status is
  'pendente=cadastro inicial; rascunho=autosave Yes; pendente_confirmacao=dados ok aguardando assinatura/confirmação; confirmado_hospede=ficha aceita pelo hóspede; enviado_oficial=sincronizado (ex.HITS/MTur); erro_sincronizacao=falha no envio oficial.';
