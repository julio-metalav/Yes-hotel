-- Seed mínima para o módulo de comunicação (MVP 2).
-- Uma conversa vinculada à reserva teste do apto 07 + mensagens + templates.
-- reserva_id deve existir em operacional_reservas (ex.: 56406834-c6d5-4ea2-8957-7db1712280f0).

-- Templates (idempotente por codigo)
insert into public.comunicacao_templates (codigo, titulo, conteudo, ativo)
values
  ('fnrh_reenvio', 'Reenviar link FNRH', 'Olá! Segue novamente o link para preenchimento do formulário de hóspedes: [LINK]. Qualquer dúvida, estamos à disposição.', true),
  ('instrucoes_acesso', 'Instruções de acesso', 'Sua senha de acesso é [SENHA]. Utilize a portaria principal e o elevador até o andar do apartamento. Em caso de dúvida, responda esta mensagem.', true),
  ('horario_cafe', 'Horário do café', 'O café da manhã é servido das 7h às 10h no refeitório. Bom apetite!', true)
on conflict (codigo) do nothing;
-- Conversa de exemplo vinculada à reserva do apto 07 (só insere se não existir por id)
insert into public.comunicacao_conversas (
  id,
  canal,
  telefone,
  reserva_id,
  status,
  ultima_mensagem_em,
  ultima_mensagem_preview
)
select
  'a1b2c3d4-e5f6-7890-abcd-ef1111111111'::uuid,
  'whatsapp',
  '+5511999990001',
  '56406834-c6d5-4ea2-8957-7db1712280f0'::uuid,
  'aberta',
  now() - interval '1 hour',
  'Não consegui abrir a porta, pode me orientar?'
where exists (
  select 1 from public.operacional_reservas where id = '56406834-c6d5-4ea2-8957-7db1712280f0'::uuid
)
and not exists (
  select 1 from public.comunicacao_conversas where id = 'a1b2c3d4-e5f6-7890-abcd-ef1111111111'::uuid
);
-- Mensagens iniciais para a conversa seed (só se a conversa existir e ainda não tiver mensagens)
insert into public.comunicacao_mensagens (conversa_id, direcao, tipo_mensagem, mensagem, status_envio, created_at)
select v.conversa_id, v.direcao, v.tipo_mensagem, v.mensagem, v.status_envio, v.created_at
from (values
  ('a1b2c3d4-e5f6-7890-abcd-ef1111111111'::uuid, 'sistema', 'evento', 'Link FNRH enviado para o hóspede.', null, now() - interval '2 hours'),
  ('a1b2c3d4-e5f6-7890-abcd-ef1111111111'::uuid, 'entrada', 'texto', 'Bom dia! Recebi o link do formulário. Preenchi e enviei.', null, now() - interval '1 hour' - interval '40 minutes'),
  ('a1b2c3d4-e5f6-7890-abcd-ef1111111111'::uuid, 'saida', 'texto', 'Ótimo! Assim que confirmarmos, você receberá as instruções de acesso ao apartamento.', 'local', now() - interval '1 hour' - interval '35 minutes'),
  ('a1b2c3d4-e5f6-7890-abcd-ef1111111111'::uuid, 'entrada', 'texto', 'Acabei de chegar mas não consegui abrir a porta, pode me orientar?', null, now() - interval '1 hour')
) as v(conversa_id, direcao, tipo_mensagem, mensagem, status_envio, created_at)
where exists (select 1 from public.comunicacao_conversas c where c.id = v.conversa_id)
and (select count(*) from public.comunicacao_mensagens m where m.conversa_id = v.conversa_id) = 0;
