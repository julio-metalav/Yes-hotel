-- Etapa 3 corrigida: estado honesto para delete remoto não confirmado.
-- revogado/revogado_em = apenas quando delete remoto for confirmado.
-- pendente_limpeza = encerramento local (ex.: checkout) feito, delete remoto pendente ou falhou.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'operacional_item_provisionamento_status' AND e.enumlabel = 'pendente_limpeza'
  ) THEN
    ALTER TYPE public.operacional_item_provisionamento_status ADD VALUE 'pendente_limpeza';
  END IF;
END
$$;

COMMENT ON TYPE public.operacional_item_provisionamento_status IS
  'pendente, provisionando, provisionado, falhou, revogado (delete remoto confirmado), pendente_limpeza (delete remoto pendente ou falhou)';
