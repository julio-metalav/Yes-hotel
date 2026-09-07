# Yes Hotel — Roteiro de testes operacional

Use este roteiro para validar primeiro acesso, login por perfil, painel, ações operacionais e importação manual.

**Escopo:** cobre o núcleo operacional do MVP (perfis `admin`, `recepcao` e `cafe`). Não cobre o perfil `operador` nem os módulos posteriores — FNRH digital v2/OCR, café da manhã, demandas, financeiro, pagamento presencial diferido, Pagar.me e sincronização HITS.

**Pré-requisitos:** Supabase com migrations aplicadas; Edge Function `internal-users-admin` publicada; pasta `ui/` servida por um servidor HTTP (não abrir arquivos por `file://`). Configurar `ui/yes-supabase-config.js` com `url` e `anonKey` do projeto.

---

## 1. Primeiro acesso

Objetivo: sem sessão, a home deve mostrar **Criar admin** quando não há usuários e **Login** quando já existe pelo menos um usuário.

| # | Ação | Resultado esperado | ☐ |
|---|------|--------------------|---|
| 1.1 | Abrir a home **sem sessão** (navegador em aba anônima ou após limpar dados do site). URL: `index.html` ou `usuarios-login-mvp.html`. | Página carrega sem erro. | |
| 1.2 | **Se não há nenhum usuário no banco:** | É exibido o painel **Primeiro acesso** com título "Primeiro acesso", texto explicativo e formulário com: Nome, Email, Senha e botão **"Criar admin"**. | |
| 1.3 | Preencher Nome, Email e Senha (mín. 6 caracteres) e clicar em **Criar admin**. | Mensagem de sucesso; em seguida a tela deve mostrar o **painel de usuários** (admin logado) ou redirecionar para o fluxo de login. | |
| 1.4 | Fazer logout. Abrir de novo a home **sem sessão**. | Agora deve aparecer o painel **Login** (título "Login"), com campos Email e Senha e botão **"Entrar"** — e **não** o formulário "Criar admin". | |
| 1.5 | **Se já existir usuário** (após 1.3 ou import manual): abrir home sem sessão. | Sempre o painel **Login**, nunca "Criar admin". | |

---

## 2. Login e perfis

Objetivo: validar login como admin, recepção e café e os redirecionamentos/bloqueios corretos.

**Preparação:** Ter pelo menos um usuário de cada perfil (admin, recepcao, cafe). O primeiro admin foi criado no passo 1.3; criar recepção e café pela tela de admin (usuarios-login-mvp, logado como admin).

| # | Ação | Resultado esperado | ☐ |
|---|------|--------------------|---|
| 2.1 | **Login como admin:** na tela de Login, informar email e senha do usuário **admin** e clicar em Entrar. | Login com sucesso. Tela de **Usuários internos** (lista de usuários + formulário novo/editar). Barra com nome, "Admin" e link "Ir para cafe", botão "Sair". | |
| 2.2 | Ainda como admin: clicar em "Ir para cafe" ou acessar `cafe-da-manha-mvp.html`. | Acesso permitido; tela do café da manhã. | |
| 2.3 | Como admin: acessar `recepcao-mvp.html`. | Acesso permitido; tela da recepção. | |
| 2.4 | Como admin: acessar `checkin-operacional-mvp.html`. | Acesso permitido; painel de check-in operacional com lista de reservas (ou vazia). Link "Importar reservas" visível na barra. | |
| 2.5 | Fazer logout. **Login como recepção:** email/senha do usuário **recepcao**, Entrar. | Login com sucesso. **Redirecionamento automático** para `recepcao-mvp.html` (recepção não fica na tela de usuários). | |
| 2.6 | Como recepção: acessar manualmente `checkin-operacional-mvp.html`. | Acesso permitido; painel de check-in. **Sem** link "Importar reservas". | |
| 2.7 | Como recepção: acessar `cafe-da-manha-mvp.html`. | Acesso permitido; tela do café. | |
| 2.8 | Como recepção: acessar `usuarios-login-mvp.html` (ou index com gestão de usuários). | Pode abrir a página, mas **não** deve ver/gerir lista de usuários como admin (ou é redirecionado para recepção). | |
| 2.9 | Fazer logout. **Login como café:** email/senha do usuário **cafe**, Entrar. | Login com sucesso. **Redirecionamento automático** para `cafe-da-manha-mvp.html`. | |
| 2.10 | Como café: tentar acessar `checkin-operacional-mvp.html`. | **Bloqueio:** mensagem de "Acesso não permitido" ou redirecionamento para login/café; **não** ver o painel de check-in. | |
| 2.11 | Como café: tentar acessar `recepcao-mvp.html`. | **Bloqueio** ou redirecionamento para café/login; não ver painel de recepção. | |
| 2.12 | Como café: acessar `importar-reservas-mvp.html`. | **Acesso negado:** mensagem de que apenas admin pode importar. | |

---

## 3. Painel operacional

Objetivo: lista de reservas, drawer, edição de hóspede, adicionar/remover, definir principal e persistência após recarregar.

**Preparação:** Logado como admin ou recepção. Ter pelo menos uma reserva no banco (importada no bloco 5 ou já existente).

| # | Ação | Resultado esperado | ☐ |
|---|------|--------------------|---|
| 3.1 | Acessar `checkin-operacional-mvp.html`. | Painel carrega; **lista de reservas** (cards por apartamento/reserva). Barra de filtros e resumo (totais) visíveis. | |
| 3.2 | Clicar em um card de reserva. | **Drawer** (painel lateral) abre com detalhe da reserva: dados da reserva, lista de hóspedes, histórico/timeline, botões de ação. | |
| 3.3 | No drawer, **editar um hóspede:** alterar nome, email ou WhatsApp e salvar (conforme UI). | Campos atualizados no drawer; sem erro. | |
| 3.4 | **Adicionar hóspede:** usar botão/ação "Adicionar hóspede". | Novo hóspede aparece na lista do drawer (ex.: "Novo hóspede"). | |
| 3.5 | **Remover um hóspede** (que não seja o único): usar ação de remover no drawer. | Hóspede some da lista no drawer. | |
| 3.6 | **Definir principal:** escolher outro hóspede como principal (ação correspondente no drawer). | Nome do hóspede principal da reserva atualiza no card e no drawer. | |
| 3.7 | **Recarregar a página** (F5 ou Ctrl+R). | Lista e drawer (se reabrir a mesma reserva) mostram os **mesmos dados** (edição, novo hóspede, remoção, principal) **persistidos**. | |

---

## 4. Ações operacionais

Objetivo: simular pagamento, FNRH, liberar acesso e marcar entrada; após recarregar, estado deve continuar salvo.

**Preparação:** Mesmo contexto do bloco 3; drawer de uma reserva aberto.

| # | Ação | Resultado esperado | ☐ |
|---|------|--------------------|---|
| 4.1 | Com uma reserva **pendente de pagamento**, usar no drawer a ação **Simular pagamento aprovado** (ou equivalente). | Reserva passa a aparecer como **pago**; no histórico/timeline aparece evento de pagamento. | |
| 4.2 | Com um hóspede elegível (ex.: "Pronto para envio"), usar **Simular confirmação de FNRH** (por hóspede ou reserva). | Status do hóspede/reserva atualiza (ex.: "FNRH confirmada"); evento no histórico. | |
| 4.3 | Usar no drawer a ação **Liberar acesso**. | Reserva fica com **acesso liberado**; evento no histórico. | |
| 4.4 | Usar no drawer a ação **Entrou no apto**. | Reserva fica com **entrou no apto**; evento no histórico. | |
| 4.5 | **Recarregar a página** e reabrir a mesma reserva no drawer. | Estado **persistido:** pagamento pago, FNRH confirmada onde aplicado, acesso liberado, entrada marcada; eventos visíveis no histórico. | |

---

## 5. Importação manual

Objetivo: apenas admin acessa importação; reservas importadas aparecem no painel.

**Preparação:** Logado como **admin**. Ter um JSON de reservas no formato aceito (array de reservas com apartamento, hospedePrincipal, checkInPrevisto, checkOutPrevisto, pagamento, hospedes, etc.).

| # | Ação | Resultado esperado | ☐ |
|---|------|--------------------|---|
| 5.1 | Acessar `importar-reservas-mvp.html` (ou clicar em "Importar reservas" no painel de check-in, estando logado como admin). | Tela de importação abre; campo para colar JSON e botão para importar. | |
| 5.2 | Colar um JSON válido com uma ou mais reservas (e hóspedes) e clicar em **Importar**. | Mensagem de sucesso (ex.: "X reserva(s) importada(s) com sucesso"). Sem erro de permissão. | |
| 5.3 | Ir para `checkin-operacional-mvp.html` (ou recarregar se já estiver nela). | As **reservas importadas aparecem na lista** do painel com dados corretos (apartamento, principal, datas, hóspedes). | |
| 5.4 | Abrir o drawer de uma das reservas importadas. | Detalhe completo; hóspedes e dados consistentes com o JSON. | |
| 5.5 | (Opcional) Logar como **recepção** e abrir `importar-reservas-mvp.html` diretamente pela URL. | **Acesso negado:** mensagem de que apenas admin pode importar. | |

---

## Resumo rápido

- **1.** Home sem sessão: sem usuários → "Criar admin"; com usuários → "Login".
- **2.** Admin: todas as telas. Recepção: recepção + check-in + café; redirecionado ao logar. Café: só café; bloqueado em check-in e recepção.
- **3.** Lista → drawer → editar/adicionar/remover hóspede, definir principal → recarregar = persistência.
- **4.** Pagamento, FNRH, liberar acesso, marcar entrada → recarregar = estado salvo.
- **5.** Admin importa JSON → reservas aparecem no painel; recepção não pode importar.
