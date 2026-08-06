-- Permite status_envio 'local' e 'mock_enviado' para mensagens enviadas sem canal real (MVP 2).
alter table public.comunicacao_mensagens
  drop constraint if exists comunicacao_mensagens_status_envio_check;
alter table public.comunicacao_mensagens
  add constraint comunicacao_mensagens_status_envio_check check (
    status_envio is null
    or status_envio in (
      'enviando', 'enviada', 'entregue', 'lida', 'falha',
      'local', 'mock_enviado'
    )
  );
