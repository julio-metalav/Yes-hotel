# Yes Hotel — Plano 01 a 05 — Entrega (sair do mock → sistema operacional inicial)

## Resumo

Os 5 blocos do plano foram revisados e estão **operacionais**. O projeto já tinha a maior parte implementada; foi feita uma correção para o bootstrap de usuários funcionar sem depender de API Next.js.

---

## Bloco 01 — Supabase como fonte da verdade ✅

**Já implementado** nas migrations existentes:

- **`supabase/migrations/0005_yes_hotel_operacional_panel_tables.sql`**
  - `operacional_reservas`: id, apartamento, hospede_principal, check_in_previsto, check_out_previsto, pagamento_status, acesso_liberado, entrou_no_apto, veiculo_placa, veiculo_cor, origem_externa, external_reservation_id, created_at, updated_at
  - `operacional_hospedes`: id, reserva_id, nome, principal, email, whatsapp, status_operacional, origem_cadastro, modo_coleta_fnrh, ultimo_envio_canal, ultimo_envio_em, tentativas_envio, created_at, updated_at
  - `operacional_reserva_eventos`: id, reserva_id, tipo, titulo, detalhe, criado_em
  - RLS para `authenticated` em todas as tabelas
  - Trigger `set_updated_at` em reservas e hóspedes

- **`supabase/migrations/0004_yes_hotel_usuarios_auth_supabase.sql`**
  - `usuarios_internos.auth_user_id` e perfis: admin, recepcao, cafe

Nenhuma migration nova foi criada; o schema atende ao plano.

---

## Bloco 02 — Backend mínimo do Yes ✅

**Já implementado** no painel (Supabase como backend):

- **Leitura:** `loadReservasFromBackend()` — busca `operacional_reservas`, `operacional_hospedes`, `operacional_reserva_eventos` e monta o modelo interno.
- **Escrita (funções `backend*` em `ui/checkin-operacional-mvp.js`):**
  - Atualizar hóspede (campo ou full): `backendUpdateHospedeCampo`, `backendUpdateHospedeFull`
  - Adicionar/remover hóspede: `backendAddHospede`, `backendRemoveHospede`
  - Definir principal: `backendSetPrincipal`
  - Registrar evento: `backendAddEvento`
  - Pagamento aprovado: `backendSetPagamentoOk`
  - Confirmar FNRH: `backendConfirmarFnrh`
  - Envio/reenvio de link: `backendEnviarLinks`
  - Liberar acesso: `backendLiberarAcesso`
  - Marcar entrada no apartamento: `backendMarcarEntrada`

Contrato: cliente Supabase (anon + sessão) com RLS; não há rotas HTTP próprias além da Edge Function de usuários.

---

## Bloco 03 — Auth real ✅

**Já implementado** em `ui/yes-supabase-auth.js` e Edge Function:

- Supabase Auth: login, logout, sessão persistida, janela de sessão (ex.: 4h).
- Perfil em `usuarios_internos` (auth_user_id): admin, recepcao, cafe.
- **Proteção das telas:**
  - **Check-in operacional** (`checkin-operacional-mvp.js`): exige usuário logado; perfil admin ou recepcao; perfil cafe redireciona para café.
  - **Recepção** (`recepcao-mvp.js`): exige login; cafe redireciona para café.
  - **Café** (`cafe-da-manha-mvp.js`): exige login e `canAccessBreakfast` (admin, recepcao, cafe).
  - **Importar reservas** (`importar-reservas-mvp.js`): apenas perfil admin.

**Correção feita:** `hasUsers()` deixou de depender de `/api/bootstrap-status` (Next.js) e passou a usar a Edge Function `internal-users-admin` com action `bootstrap_status`, permitindo uso com UI estática.

---

## Bloco 04 — Painel conectado ao backend ✅

**Já implementado:**

- `PAINEL_DATA_SOURCE = PAINEL_DATA_SOURCE_BACKEND` em `checkin-operacional-mvp.js`.
- Carregamento: `loadReservasOperacionaisFromProvider()` → `loadReservasFromBackend()`.
- Drawer e ações do painel chamam as funções `backend*` e em seguida `refresh()` ou `refreshFromSource()` (recarrega do Supabase).
- Timeline vem do banco (`operacional_reserva_eventos`).

UX do painel mantida; fonte de dados é o Supabase.

---

## Bloco 05 — Entrada manual / importação sem HITS ✅

**Já implementado** em `ui/importar-reservas-mvp.html` + `ui/importar-reservas-mvp.js`:

- Apenas perfil **admin** pode importar.
- Campo para colar JSON (array de reservas ou objeto com chave `reservas`).
- Inserção em `operacional_reservas` e `operacional_hospedes` (e hóspede principal padrão quando não há lista de hóspedes).
- Formato do JSON compatível com o modelo do painel (apartamento, hospedePrincipal, checkInPrevisto, checkOutPrevisto, pagamento, hospedes, etc.).

Permite alimentar o sistema sem HITS.

---

## Arquivo alterado nesta passagem

- **`ui/yes-supabase-auth.js`**  
  - `hasUsers()` passou a chamar a Edge Function `internal-users-admin` com `action: "bootstrap_status"` em vez de `GET /api/bootstrap-status`.

---

## Como usar

1. **Supabase:** aplicar migrations (0001 a 0005) no projeto Supabase do Yes Hotel.
2. **Edge Function:** publicar `internal-users-admin` e configurar variáveis (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY).
3. **UI:** servir a pasta `ui/` (ex.: servidor estático ou hospedagem com CORS adequado); carregar `yes-supabase-config.js` com `url` e `anonKey` do projeto.
4. **Primeiro acesso:** na tela de login, se não houver usuários, aparece o formulário de bootstrap do primeiro admin; em seguida, login normal.
5. **Importar reservas:** logar como admin e abrir “Importar reservas”; colar JSON e importar.
6. **Painel:** logar como recepção ou admin e usar o painel de check-in; todas as ações persistem no Supabase.

---

## O que ainda depende do HITS no futuro

- Carregar reservas a partir do HITS (em vez de só manual/importação).
- Sincronizar identificador externo (`external_reservation_id`) quando houver integração.
- Nenhuma alteração de modelo de dados necessária para isso; o painel já está preparado para trocar a origem dos dados quando o adaptador HITS estiver ativo com credenciais.

---

## Sugestão de commits

Se quiser registrar em commits separados:

1. `fix: use edge function for bootstrap status (hasUsers) so static UI works without Next.js`
2. (Opcional) `docs: add PLANO_01_A_05_ENTREGA.md with delivery summary`

Se preferir um único commit:  
`fix: hasUsers via edge function; docs: plan 01-05 delivery summary`
