-- Permite segunda cobrança Pagar.me na mesma reserva após liquidação parcial
-- (status paid), mantendo exclusividade apenas enquanto houver cobrança ativa.
--
-- Antes: índice parcial incluía paid/refunded/chargeback → 1ª paid bloqueava
-- qualquer nova linha na reserva.
-- Depois: apenas created/pending/processing serializam criação concorrente.

drop index if exists public.operacional_cobrancas_pagarme_reserva_ativa_uidx;

create unique index if not exists operacional_cobrancas_pagarme_reserva_ativa_uidx
  on public.operacional_cobrancas_pagarme (reserva_id)
  where status in ('created', 'pending', 'processing');

comment on index public.operacional_cobrancas_pagarme_reserva_ativa_uidx is
  'No máximo uma cobrança Pagar.me ativa (created/pending/processing) por reserva. paid/refunded/chargeback não bloqueiam nova obrigação com saldo restante.';
