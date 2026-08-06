-- Fase 1 MVP 3: unicidade (canal, telefone) para localizar ou criar conversa sem duplicatas.
-- Convenção: telefone armazenado em formato E.164 sem "+" (ex.: 5511999990001).
-- Se esta migration falhar com "duplicate key" ou "could not create unique index", há duplicados
-- após a normalização; use docs/YES_HOTEL_COMUNICACAO_MVP_3_FASE_1_PRE_CHECK_0013.md (queries 3.2 e 3.3 e saneamento) antes de reaplicar.

-- 1. Normalizar telefone existente (remove "+" e trim)
update public.comunicacao_conversas
set telefone = trim(replace(telefone, '+', ''))
where telefone <> trim(replace(telefone, '+', ''));
-- 2. Índice único: uma conversa por (canal, telefone)
create unique index comunicacao_conversas_canal_telefone_uidx
  on public.comunicacao_conversas (canal, telefone);
