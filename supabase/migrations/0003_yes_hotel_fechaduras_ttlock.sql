begin;

-- Fechaduras TTLock reais do Yes Hotel.
-- Esta migration cadastra somente fechaduras de apartamentos e portoes.

insert into public.fechaduras (
    tipo_fechadura,
    apartamento_id,
    identificador_externo_ttlock
)
select
    'apartamento',
    a.id,
    v.lock_id
from (
    values
        ('01', '12438320'),
        ('02', '13865804'),
        ('03', '13380992'),
        ('04', '13714612'),
        ('05', '13712298'),
        ('06', '13865338'),
        ('07', '15461754'),
        ('08', '15461978'),
        ('09', '15615070'),
        ('10', '15615492'),
        ('11', '13278872'),
        ('12', '15194458'),
        ('13', '12179640'),
        ('14', '16000694'),
        ('15', '16001466'),
        ('16', '15193942'),
        ('17', '10925449'),
        ('18', '16865856'),
        ('19', '13393574'),
        ('20', '13714264'),
        ('21', '16624716'),
        ('22', '16362800'),
        ('23', '16144192'),
        ('24', '16362570'),
        ('25', '12195482'),
        ('26', '13772586'),
        ('27', '12437402'),
        ('28', '16624678'),
        ('29', '13772222'),
        ('30', '12438732'),
        ('31', '12699520'),
        ('32', '16144674'),
        ('33', '13327582'),
        ('34', '16274746'),
        ('35', '13380336'),
        ('36', '12308910'),
        ('37', '13711876'),
        ('38', '5956901'),
        ('39', '13393058'),
        ('40', '11733356')
) as v(numero_apartamento, lock_id)
join public.apartamentos a
    on a.numero = v.numero_apartamento
where not exists (
    select 1
    from public.fechaduras f
    where f.identificador_externo_ttlock = v.lock_id
       or (f.tipo_fechadura = 'apartamento' and f.apartamento_id = a.id)
);

insert into public.fechaduras (
    tipo_fechadura,
    portao_id,
    identificador_externo_ttlock
)
select
    v.tipo_fechadura,
    p.id,
    v.lock_id
from (
    values
        ('1947', 'portao_externo', '25709122'),
        ('1947', 'portao_interno', '25709168'),
        ('1967', 'portao_externo', '10939258'),
        ('1967', 'portao_interno', '10939408')
) as v(identificador_portao, tipo_fechadura, lock_id)
join public.portoes p
    on p.identificador_operacional = v.identificador_portao
where not exists (
    select 1
    from public.fechaduras f
    where f.identificador_externo_ttlock = v.lock_id
       or (
            f.portao_id = p.id
            and f.tipo_fechadura = v.tipo_fechadura
       )
);

commit;
