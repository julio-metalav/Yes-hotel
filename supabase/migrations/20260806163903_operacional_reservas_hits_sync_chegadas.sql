-- Migration: operacional_reservas — sync HITS (mock) + chegadas
-- NÃO APLICAR automaticamente. Gate humano obrigatório.
--
-- Alterações (baseadas no schema real do projeto minmmecajnmjqlgacfoz):
-- 1) Ampliar pagamento_status: pago|pendente|parcial|desconhecido
-- 2) Ampliar pms_reservas.payment_mapped com os mesmos valores
-- 3) status_reserva: ativa|cancelada (default ativa)
-- 4) synced_at timestamptz nullable em operacional_reservas
-- 5) Índices para chegadas futuras ativas e hospedagens atuais
--
-- Já existentes (não recriar):
-- - operacional_reservas_origem_external_uidx (origem_externa, external_reservation_id)
-- - pms_reservas_provider_external_key (provider, external_reservation_id)
-- - pms_hospedes_provider_guest_key (provider, external_guest_id)
--
-- Rollback documentado ao final do arquivo.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) pagamento_status operacional
-- ---------------------------------------------------------------------------
ALTER TABLE public.operacional_reservas
  DROP CONSTRAINT IF EXISTS operacional_reservas_pagamento_status_check;

ALTER TABLE public.operacional_reservas
  ADD CONSTRAINT operacional_reservas_pagamento_status_check
  CHECK (pagamento_status = ANY (ARRAY[
    'pago'::text,
    'pendente'::text,
    'parcial'::text,
    'desconhecido'::text
  ]));

-- ---------------------------------------------------------------------------
-- 2) payment_mapped espelho PMS (permite provider='hits' com mesmos estados)
-- ---------------------------------------------------------------------------
ALTER TABLE public.pms_reservas
  DROP CONSTRAINT IF EXISTS pms_reservas_payment_mapped_check;

ALTER TABLE public.pms_reservas
  ADD CONSTRAINT pms_reservas_payment_mapped_check
  CHECK (payment_mapped = ANY (ARRAY[
    'pago'::text,
    'pendente'::text,
    'parcial'::text,
    'desconhecido'::text
  ]));

-- ---------------------------------------------------------------------------
-- 3) status_reserva + synced_at
-- ---------------------------------------------------------------------------
ALTER TABLE public.operacional_reservas
  ADD COLUMN IF NOT EXISTS status_reserva text NOT NULL DEFAULT 'ativa';

ALTER TABLE public.operacional_reservas
  DROP CONSTRAINT IF EXISTS operacional_reservas_status_reserva_check;

ALTER TABLE public.operacional_reservas
  ADD CONSTRAINT operacional_reservas_status_reserva_check
  CHECK (status_reserva = ANY (ARRAY['ativa'::text, 'cancelada'::text]));

ALTER TABLE public.operacional_reservas
  ADD COLUMN IF NOT EXISTS synced_at timestamptz;

COMMENT ON COLUMN public.operacional_reservas.status_reserva IS
  'ativa|cancelada. Cancelamento HITS preserva a linha (sem delete físico).';
COMMENT ON COLUMN public.operacional_reservas.synced_at IS
  'Última projeção bem-sucedida a partir do espelho PMS (provider hits/hospedin).';
COMMENT ON COLUMN public.operacional_reservas.pagamento_status IS
  'pago|pendente|parcial|desconhecido. desconhecido nunca deve mapear para pendente.';

-- ---------------------------------------------------------------------------
-- 4) Índices para chegadas / hospedados (não duplicar uidx origem_externa)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS operacional_reservas_ativas_check_in_idx
  ON public.operacional_reservas (check_in_previsto, apartamento)
  WHERE status_reserva = 'ativa';

CREATE INDEX IF NOT EXISTS operacional_reservas_check_window_idx
  ON public.operacional_reservas (check_in_previsto, check_out_previsto);

CREATE INDEX IF NOT EXISTS operacional_reservas_hospedados_idx
  ON public.operacional_reservas (check_in_previsto, check_out_previsto, apartamento)
  WHERE status_reserva = 'ativa' AND entrou_no_apto = true;

CREATE INDEX IF NOT EXISTS operacional_reserva_eventos_criado_em_idx
  ON public.operacional_reserva_eventos (reserva_id, criado_em DESC);

COMMIT;

-- =============================================================================
-- ROLLBACK (manual; não executar em produção sem gate)
-- =============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS public.operacional_reserva_eventos_criado_em_idx;
-- DROP INDEX IF EXISTS public.operacional_reservas_hospedados_idx;
-- DROP INDEX IF EXISTS public.operacional_reservas_check_window_idx;
-- DROP INDEX IF EXISTS public.operacional_reservas_ativas_check_in_idx;
-- ALTER TABLE public.operacional_reservas DROP COLUMN IF EXISTS synced_at;
-- ALTER TABLE public.operacional_reservas DROP CONSTRAINT IF EXISTS operacional_reservas_status_reserva_check;
-- ALTER TABLE public.operacional_reservas DROP COLUMN IF EXISTS status_reserva;
-- -- Restaurar checks binários (perde parcial/desconhecido se houver dados):
-- ALTER TABLE public.operacional_reservas DROP CONSTRAINT IF EXISTS operacional_reservas_pagamento_status_check;
-- ALTER TABLE public.operacional_reservas ADD CONSTRAINT operacional_reservas_pagamento_status_check
--   CHECK (pagamento_status = ANY (ARRAY['pendente'::text, 'pago'::text]));
-- ALTER TABLE public.pms_reservas DROP CONSTRAINT IF EXISTS pms_reservas_payment_mapped_check;
-- ALTER TABLE public.pms_reservas ADD CONSTRAINT pms_reservas_payment_mapped_check
--   CHECK (payment_mapped = ANY (ARRAY['pendente'::text, 'pago'::text]));
-- COMMIT;
