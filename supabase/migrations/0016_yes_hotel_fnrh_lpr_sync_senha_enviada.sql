-- FNRH: campos LPR (principal), sincronização HITS e controle de envio de senha.
-- Não altera estrutura existente de reservas; apenas adiciona colunas.

-- fnrh_hospedes: LPR (cor/modelo veículo) e sync YES → HITS
alter table public.fnrh_hospedes
  add column if not exists cor_veiculo text not null default '',
  add column if not exists modelo_veiculo text not null default '',
  add column if not exists fnrh_sync_status text not null default 'pendente'
    check (fnrh_sync_status in ('pendente', 'enviado', 'erro')),
  add column if not exists fnrh_sync_enviado_em timestamptz,
  add column if not exists fnrh_sync_erro text;
comment on column public.fnrh_hospedes.cor_veiculo is 'Cor do veículo (LPR, hóspede principal).';
comment on column public.fnrh_hospedes.modelo_veiculo is 'Modelo do veículo (LPR, hóspede principal).';
comment on column public.fnrh_hospedes.fnrh_sync_status is 'Status de sincronização com HITS: pendente, enviado, erro.';
comment on column public.fnrh_hospedes.fnrh_sync_enviado_em is 'Timestamp do último envio ao HITS.';
comment on column public.fnrh_hospedes.fnrh_sync_erro is 'Mensagem de erro na última tentativa de sync com HITS.';
-- operacional_reservas: controle de envio de senha (para regra de envio automático)
alter table public.operacional_reservas
  add column if not exists senha_enviada_em timestamptz;
comment on column public.operacional_reservas.senha_enviada_em is 'Timestamp do primeiro envio da senha ao hóspede (manual ou automático).';
-- operacional_reserva_eventos: suportar detalhe JSON para logs de envio (opcional; detalhe já é text)
-- Tipos de evento: envio_manual_senha, envio_auto_fnrh, envio_auto_senha, fnrh_sync_hits, reenvio_fnrh_porta
-- Detalhe pode conter JSON com reserva_id, usuario_id, canais, qtd_fnrh_pendentes, tipo_evento, etc.;
