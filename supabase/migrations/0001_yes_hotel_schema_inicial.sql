create extension if not exists "pgcrypto";

-- Cadastros estruturais
create table public.blocos (
    id uuid primary key default gen_random_uuid(),
    nome text not null,
    codigo_portao_referencia text,
    ativo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint blocos_nome_key unique (nome)
);

create table public.portoes (
    id uuid primary key default gen_random_uuid(),
    bloco_id uuid not null,
    identificador_operacional text not null,
    ativo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint portoes_bloco_id_key unique (bloco_id),
    constraint portoes_identificador_operacional_key unique (identificador_operacional),
    constraint portoes_bloco_id_fkey
        foreign key (bloco_id) references public.blocos (id)
);

create table public.apartamentos (
    id uuid primary key default gen_random_uuid(),
    bloco_id uuid not null,
    numero text not null,
    identificador_operacional text,
    ativo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint apartamentos_numero_key unique (numero),
    constraint apartamentos_bloco_id_fkey
        foreign key (bloco_id) references public.blocos (id)
);

create table public.fechaduras (
    id uuid primary key default gen_random_uuid(),
    tipo_fechadura text not null,
    apartamento_id uuid,
    portao_id uuid,
    identificador_externo_ttlock text not null,
    ativo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint fechaduras_identificador_externo_ttlock_key unique (identificador_externo_ttlock),
    constraint fechaduras_apartamento_id_fkey
        foreign key (apartamento_id) references public.apartamentos (id),
    constraint fechaduras_portao_id_fkey
        foreign key (portao_id) references public.portoes (id),
    constraint fechaduras_tipo_fechadura_check
        check (tipo_fechadura in ('apartamento', 'portao_externo', 'portao_interno')),
    constraint fechaduras_vinculo_estrutural_check
        check (
            (tipo_fechadura = 'apartamento' and apartamento_id is not null and portao_id is null)
            or
            (tipo_fechadura in ('portao_externo', 'portao_interno') and portao_id is not null and apartamento_id is null)
        )
);

-- Operacao principal
create table public.reservas (
    id uuid primary key default gen_random_uuid(),
    identificador_reserva_externa text,
    origem_reserva text not null,
    apartamento_id uuid not null,
    bloco_id uuid not null,
    data_checkin_prevista date not null,
    data_checkout_prevista date not null,
    status_reserva text not null,
    status_operacional_reserva text not null,
    contato_email_principal text,
    contato_whatsapp_principal text,
    observacoes_operacionais text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint reservas_apartamento_id_fkey
        foreign key (apartamento_id) references public.apartamentos (id),
    constraint reservas_bloco_id_fkey
        foreign key (bloco_id) references public.blocos (id),
    constraint reservas_periodo_check
        check (data_checkout_prevista >= data_checkin_prevista),
    constraint reservas_status_reserva_check
        check (status_reserva in ('recebida', 'confirmada', 'cancelada', 'em_hospedagem', 'encerrada')),
    constraint reservas_status_operacional_reserva_check
        check (status_operacional_reserva in ('aguardando_fnrh', 'apta_para_credencial', 'credencial_gerada', 'chegada_detectada', 'com_alerta', 'concluida'))
);

create unique index reservas_origem_identificador_reserva_externa_uidx
    on public.reservas (origem_reserva, identificador_reserva_externa)
    where identificador_reserva_externa is not null;

create table public.hospedes (
    id uuid primary key default gen_random_uuid(),
    nome text not null,
    email text,
    telefone text,
    documento text,
    nacionalidade text,
    data_nascimento date,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.reserva_hospedes (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null,
    hospede_id uuid not null,
    papel_na_reserva text not null,
    ordem_na_reserva integer,
    created_at timestamptz not null default now(),
    constraint reserva_hospedes_reserva_hospede_key unique (reserva_id, hospede_id),
    constraint reserva_hospedes_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint reserva_hospedes_hospede_id_fkey
        foreign key (hospede_id) references public.hospedes (id),
    constraint reserva_hospedes_papel_na_reserva_check
        check (papel_na_reserva in ('principal', 'acompanhante'))
);

create table public.checkins_digitais (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null,
    referencia_link_checkin text,
    status_checkin_digital text not null,
    enviado_em timestamptz,
    preenchido_em timestamptz,
    pendente_apos_chegada boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint checkins_digitais_reserva_id_key unique (reserva_id),
    constraint checkins_digitais_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint checkins_digitais_status_checkin_digital_check
        check (status_checkin_digital in ('nao_iniciado', 'enviado', 'preenchido', 'pendente_apos_chegada'))
);

create table public.pagamentos_operacionais (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null,
    status_pagamento_operacional text not null,
    origem_status text,
    atualizado_em timestamptz not null,
    observacao text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint pagamentos_operacionais_reserva_id_key unique (reserva_id),
    constraint pagamentos_operacionais_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint pagamentos_operacionais_status_check
        check (status_pagamento_operacional in ('pendente', 'confirmado', 'dispensado', 'indefinido'))
);

-- Usuarios internos
create table public.usuarios_internos (
    id uuid primary key default gen_random_uuid(),
    nome text not null,
    email_login text not null,
    perfil_usuario text not null,
    ativo boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint usuarios_internos_email_login_key unique (email_login),
    constraint usuarios_internos_perfil_usuario_check
        check (perfil_usuario in ('operacional', 'administrativo'))
);

-- Credenciais e acesso
create table public.acessos_senhas (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null,
    status_credencial text not null,
    senha_operacional text not null,
    validade_inicio timestamptz not null,
    validade_fim timestamptz not null,
    gerada_em timestamptz not null,
    enviada_ao_hospede_em timestamptz,
    motivo_revogacao text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint acessos_senhas_reserva_id_key unique (reserva_id),
    constraint acessos_senhas_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint acessos_senhas_status_credencial_check
        check (status_credencial in ('pendente', 'gerada', 'provisionando', 'ativa', 'expirada', 'revogada', 'erro')),
    constraint acessos_senhas_validade_check
        check (validade_fim >= validade_inicio)
);

create table public.acessos_provisionamentos (
    id uuid primary key default gen_random_uuid(),
    acesso_senha_id uuid not null,
    fechadura_id uuid not null,
    status_provisionamento text not null,
    provisionado_em timestamptz,
    ultima_tentativa_em timestamptz,
    erro_ultima_tentativa text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint acessos_provisionamentos_acesso_senha_fechadura_key unique (acesso_senha_id, fechadura_id),
    constraint acessos_provisionamentos_acesso_senha_id_fkey
        foreign key (acesso_senha_id) references public.acessos_senhas (id),
    constraint acessos_provisionamentos_fechadura_id_fkey
        foreign key (fechadura_id) references public.fechaduras (id),
    constraint acessos_provisionamentos_status_check
        check (status_provisionamento in ('pendente', 'provisionado', 'erro', 'revogado'))
);

create table public.acessos_eventos (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid,
    fechadura_id uuid not null,
    acesso_senha_id uuid,
    tipo_evento_acesso text not null,
    ocorreu_em timestamptz not null,
    evento_primeiro_acesso boolean not null default false,
    origem_evento text,
    payload_referencia jsonb,
    created_at timestamptz not null default now(),
    constraint acessos_eventos_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint acessos_eventos_fechadura_id_fkey
        foreign key (fechadura_id) references public.fechaduras (id),
    constraint acessos_eventos_acesso_senha_id_fkey
        foreign key (acesso_senha_id) references public.acessos_senhas (id),
    constraint acessos_eventos_tipo_evento_acesso_check
        check (tipo_evento_acesso in ('entrada_validada', 'tentativa_negada', 'revogacao_detectada', 'evento_nao_classificado'))
);

-- Comunicacao e automacao
create table public.mensagens (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null,
    tipo_mensagem text not null,
    canal_mensagem text not null,
    destinatario text not null,
    status_mensagem text not null,
    conteudo_referencia text,
    enviada_em timestamptz,
    retorno_provedor jsonb,
    tentativas integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint mensagens_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint mensagens_canal_mensagem_check
        check (canal_mensagem in ('email', 'whatsapp')),
    constraint mensagens_status_mensagem_check
        check (status_mensagem in ('pendente', 'enviada', 'entregue', 'erro')),
    constraint mensagens_tentativas_check
        check (tentativas >= 0)
);

create table public.jobs_automacao (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid,
    tipo_job text not null,
    status_job text not null,
    agendado_para timestamptz not null,
    executado_em timestamptz,
    tentativas integer not null default 0,
    erro_ultima_execucao text,
    referencia_entidade text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint jobs_automacao_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint jobs_automacao_status_job_check
        check (status_job in ('pendente', 'executando', 'concluido', 'erro', 'cancelado')),
    constraint jobs_automacao_tentativas_check
        check (tentativas >= 0)
);

-- Alertas
create table public.alertas_operacionais (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid,
    tipo_alerta text not null,
    severidade text not null,
    status_alerta text not null,
    descricao_resumida text not null,
    aberto_em timestamptz not null,
    resolvido_em timestamptz,
    resolvido_por_usuario_interno_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint alertas_operacionais_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint alertas_operacionais_resolvido_por_usuario_interno_id_fkey
        foreign key (resolvido_por_usuario_interno_id) references public.usuarios_internos (id),
    constraint alertas_operacionais_severidade_check
        check (severidade in ('baixa', 'media', 'alta', 'critica')),
    constraint alertas_operacionais_status_alerta_check
        check (status_alerta in ('aberto', 'em_tratamento', 'resolvido', 'cancelado'))
);

-- Veiculos e LPR
create table public.placas_autorizadas (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null,
    hospede_id uuid,
    placa text not null,
    origem_cadastro text not null,
    ativa boolean not null default true,
    autorizada_inicio timestamptz,
    autorizada_fim timestamptz,
    criada_por_usuario_interno_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint placas_autorizadas_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint placas_autorizadas_hospede_id_fkey
        foreign key (hospede_id) references public.hospedes (id),
    constraint placas_autorizadas_criada_por_usuario_interno_id_fkey
        foreign key (criada_por_usuario_interno_id) references public.usuarios_internos (id),
    constraint placas_autorizadas_origem_cadastro_check
        check (origem_cadastro in ('fnrh', 'manual')),
    constraint placas_autorizadas_janela_check
        check (
            autorizada_inicio is null
            or autorizada_fim is null
            or autorizada_fim >= autorizada_inicio
        )
);

create table public.eventos_lpr (
    id uuid primary key default gen_random_uuid(),
    placa_lida text not null,
    reserva_id uuid,
    placa_autorizada_id uuid,
    ocorreu_em timestamptz not null,
    resultado_validacao text not null,
    acao_executada text,
    origem_equipamento text,
    created_at timestamptz not null default now(),
    constraint eventos_lpr_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint eventos_lpr_placa_autorizada_id_fkey
        foreign key (placa_autorizada_id) references public.placas_autorizadas (id),
    constraint eventos_lpr_resultado_validacao_check
        check (resultado_validacao in ('autorizada', 'rejeitada', 'nao_encontrada', 'pendente_correlacao'))
);

-- Cafe da manha
create table public.cafe_presencas (
    id uuid primary key default gen_random_uuid(),
    reserva_id uuid not null,
    data_operacao date not null,
    apartamento_id uuid not null,
    quantidade_esperada integer not null,
    quantidade_presente integer not null default 0,
    status_operacional_cafe text,
    registrado_por_usuario_interno_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cafe_presencas_reserva_data_operacao_key unique (reserva_id, data_operacao),
    constraint cafe_presencas_reserva_id_fkey
        foreign key (reserva_id) references public.reservas (id),
    constraint cafe_presencas_apartamento_id_fkey
        foreign key (apartamento_id) references public.apartamentos (id),
    constraint cafe_presencas_registrado_por_usuario_interno_id_fkey
        foreign key (registrado_por_usuario_interno_id) references public.usuarios_internos (id),
    constraint cafe_presencas_quantidades_check
        check (
            quantidade_esperada >= 0
            and quantidade_presente >= 0
            and quantidade_presente <= quantidade_esperada
        ),
    constraint cafe_presencas_status_operacional_cafe_check
        check (
            status_operacional_cafe is null
            or status_operacional_cafe in ('nao_iniciado', 'parcial', 'concluido')
        )
);
