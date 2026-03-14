begin;

-- Estrutura fisica inicial minima do Yes Hotel.
-- Esta migration cadastra somente blocos, portoes e apartamentos.
-- Fechaduras ficam fora nesta etapa porque os identificadores externos TTLock
-- ainda nao foram confirmados.

insert into public.blocos (nome, codigo_portao_referencia)
values
    ('Bloco 1', '1947'),
    ('Bloco 2', '1967')
on conflict (nome) do nothing;

insert into public.portoes (bloco_id, identificador_operacional)
select
    b.id,
    v.identificador_operacional
from (
    values
        ('Bloco 1', '1947'),
        ('Bloco 2', '1967')
) as v(nome_bloco, identificador_operacional)
join public.blocos b
    on b.nome = v.nome_bloco
where not exists (
    select 1
    from public.portoes p
    where p.bloco_id = b.id
       or p.identificador_operacional = v.identificador_operacional
);

insert into public.apartamentos (bloco_id, numero)
select
    b.id,
    lpad(gs.numero::text, 2, '0') as numero
from generate_series(1, 40) as gs(numero)
join public.blocos b
    on b.nome = case
        when gs.numero between 1 and 20 then 'Bloco 1'
        else 'Bloco 2'
    end
where not exists (
    select 1
    from public.apartamentos a
    where a.numero = lpad(gs.numero::text, 2, '0')
);

commit;
