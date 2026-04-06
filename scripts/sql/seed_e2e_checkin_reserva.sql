-- Reserva operacional de teste E2E (check-in / FNRH / TTLock).
-- Executar no SQL Editor do Supabase ou: npx supabase db query --linked -f scripts/sql/seed_e2e_checkin_reserva.sql
--
-- Requisitos: migrations 0005+ (operacional_*), 0015 (fnrh_hospedes, fnrh_status_agregado), trigger 0006 (credencial ao liberar).
-- Apartamento 39: existe no seed 0002 (01–40); fora do apto 07; necessário para criar itens TTLock ao liberar acesso.
-- WhatsApp: mesmo padrão fictício usado em ui/reservas-operacionais.json (11999990001).

DO $$
DECLARE
  v_reserva_id uuid := gen_random_uuid();
  v_hospede_id uuid := gen_random_uuid();
  v_token text := replace(gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO public.operacional_reservas (
    id,
    apartamento,
    hospede_principal,
    check_in_previsto,
    check_out_previsto,
    pagamento_status,
    acesso_liberado,
    entrou_no_apto,
    veiculo_placa,
    veiculo_cor,
    origem_externa,
    external_reservation_id,
    fnrh_status_agregado
  ) VALUES (
    v_reserva_id,
    '39',
    'Julio Cesar Oliveira TESTE',
    (current_date + interval '10 days')::date,
    (current_date + interval '12 days')::date,
    'pago',
    false,
    false,
    '',
    '',
    'manual',
    'RESERVA TESTE E2E CHATGPT',
    'fnrh_pendente'
  );

  INSERT INTO public.operacional_hospedes (
    id,
    reserva_id,
    nome,
    principal,
    email,
    whatsapp,
    status_operacional,
    origem_cadastro,
    modo_coleta_fnrh,
    tentativas_envio
  ) VALUES (
    v_hospede_id,
    v_reserva_id,
    'Julio Cesar Oliveira TESTE',
    true,
    'juliocesar.jcoliveira@gmail.com',
    '11999990001',
    'pronto_para_envio',
    'novo',
    'preenchimento_completo',
    0
  );

  INSERT INTO public.fnrh_hospedes (
    reserva_id,
    hospede_id,
    link_token,
    hospede_nome,
    status
  ) VALUES (
    v_reserva_id,
    v_hospede_id,
    v_token,
    'Julio Cesar Oliveira TESTE',
    'pendente'
  );

  INSERT INTO public.operacional_reserva_eventos (reserva_id, tipo, titulo, detalhe)
  VALUES (
    v_reserva_id,
    'reserva_criada',
    'Reserva de teste E2E',
    'RESERVA TESTE E2E CHATGPT — seed scripts/sql/seed_e2e_checkin_reserva.sql; apt 39; não usar como reserva real.'
  );

  RAISE NOTICE 'E2E reserva_id=% hospede_id=% fnrh_link_token=%', v_reserva_id, v_hospede_id, v_token;
END $$;

-- Confirmação (última linha criada com esta marca)
SELECT
  r.id AS reserva_id,
  r.apartamento,
  r.check_in_previsto,
  r.check_out_previsto,
  r.pagamento_status,
  r.acesso_liberado,
  r.fnrh_status_agregado,
  (SELECT count(*)::int FROM public.operacional_credenciais_acesso c WHERE c.reserva_id = r.id) AS qtd_credenciais
FROM public.operacional_reservas r
WHERE r.external_reservation_id = 'RESERVA TESTE E2E CHATGPT'
ORDER BY r.created_at DESC
LIMIT 1;
