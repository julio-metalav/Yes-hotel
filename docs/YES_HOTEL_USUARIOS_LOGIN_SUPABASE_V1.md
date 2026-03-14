# Yes Hotel - Usuarios e Login Supabase V1

## Solucao escolhida

Foi escolhida a abordagem `Supabase Auth + perfil interno em public.usuarios_internos + edge function administrativa`.

## Por que foi escolhida

- usa autenticacao real do Supabase para email e senha
- evita manter hash e sessao manual como fonte principal de verdade
- evita expor `service_role` na UI estatica
- mantem a gestao de usuarios simples para o MVP

## Estrutura minima criada

### Auth

- credenciais de email e senha no `Supabase Auth`

### Perfil interno

Tabela existente reaproveitada:

- `public.usuarios_internos`

Ajustes minimos:

- `auth_user_id`
- perfis `admin`, `recepcao`, `cafe`
- `ativo`
- politica minima para o usuario autenticado ler apenas o proprio perfil

### Operacao administrativa

Edge function:

- `internal-users-admin`

Responsabilidades:

- verificar se ja existem usuarios
- bootstrap do primeiro admin
- listar usuarios
- criar usuario
- atualizar usuario

## Perfis

- `admin`: acesso total, inclusive gestao de usuarios
- `recepcao`: acesso operacional geral, exceto gestao de usuarios
- `cafe`: acesso apenas a tela do cafe da manha

## Regra de sessao de 4 horas

- o login usa sessao real do Supabase Auth
- adicionalmente, a aplicacao controla uma janela operacional local de 4 horas
- ao ultrapassar 4 horas, a aplicacao faz `signOut()` e exige novo login

## Telas afetadas

- `ui/usuarios-login-mvp.html`
- `ui/cafe-da-manha-mvp.html`

As duas telas passaram a usar:

- configuracao do Supabase em `ui/yes-supabase-config.js`
- biblioteca de autenticacao em `ui/yes-supabase-auth.js`

## Limitacoes atuais

- ainda e uma UI estatica
- a configuracao do Supabase precisa ser preenchida manualmente no arquivo de configuracao
- a sessao de 4 horas e uma regra operacional da aplicacao, acima da sessao base do provider
- ainda nao ha reset de senha, convite, 2FA ou modulo completo de administracao

## Proximos passos possiveis sem inflar escopo

1. preencher a configuracao real do Supabase
2. aplicar a migration minima
3. publicar a edge function
4. testar bootstrap do primeiro admin
5. conectar as proximas telas operacionais ao mesmo controle de acesso
