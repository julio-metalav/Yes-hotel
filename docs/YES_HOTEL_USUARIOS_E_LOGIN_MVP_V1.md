# Yes Hotel - Usuarios e Login MVP V1

## Objetivo

Entregar um modulo minimo de usuarios internos e login para operacao local do sistema, com sessao de 4 horas, perfis simples e controle basico de acesso.

## Estrutura minima adotada

Foi adotada uma solucao local em `HTML + CSS + JS` puro, com:

- usuarios salvos em `localStorage`
- sessoes salvas em `localStorage`
- hash de senha com Web Crypto API usando `PBKDF2 + SHA-256`
- expiracao de sessao em 4 horas

## Campos de usuario

- `id`
- `name`
- `email`
- `passwordHash`
- `passwordSalt`
- `role`
- `active`
- `createdAt`
- `updatedAt`

## Campos de sessao

- `id`
- `userId`
- `token`
- `expiresAt`
- `createdAt`
- `invalidatedAt`

## Perfis iniciais

- `admin`
- `recepcao`
- `cafe`

## Regra de sessao de 4 horas

- login cria uma sessao valida por 4 horas
- usuario inativo nao entra
- logout invalida a sessao atual
- sessao expirada exige novo login

## Telas criadas

- `ui/usuarios-login-mvp.html`
  - bootstrap do primeiro admin
  - login por email e senha
  - lista de usuarios
  - cadastro e edicao de usuario
- `ui/cafe-da-manha-mvp.html`
  - passou a exigir sessao valida
  - respeita o acesso por perfil para a operacao do cafe

## Limitacoes atuais

- armazenamento local no navegador
- nao ha banco nem sincronizacao entre dispositivos
- nao ha reset de senha, convite, 2FA ou trilha de auditoria
- recepcao e cafe compartilham a mesma tela operacional atual, porque o sistema ainda nao tem outros modulos de operacao montados

## Proximos passos possiveis

1. migrar usuarios e sessoes para persistencia real
2. conectar as telas operacionais reais ao mesmo controle de sessao
3. adicionar invalidacao global de sessao
4. so depois discutir refinamentos de permissao
