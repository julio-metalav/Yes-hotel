# Yes Hotel — Fase TTLock 2: Adaptador TTLock Cloud (passcode temporário)

## Escopo desta fase

- Integração com TTLock Open Platform para **passcode temporário** (keyboard password).
- **Não** usar eKey como fluxo principal.
- Autenticar, criar passcode nas fechaduras, persistir resultado e atualizar status de credencial e itens.

## Variáveis de ambiente

Configure em `.env` (não versionar valores reais):

| Env | Obrigatório | Descrição |
|-----|-------------|-----------|
| `TTLOCK_CLIENT_ID` | Sim | client_id / app_id da aplicação TTLock |
| `TTLOCK_CLIENT_SECRET` | Sim | client_secret / app_secret |
| `TTLOCK_USERNAME` | Sim | Usuário da conta TTLock (conta APP, não desenvolvedor) |
| `TTLOCK_PASSWORD` | Sim | Senha em texto plano (o cliente aplica MD5 na chamada) |
| `TTLOCK_TOKEN_URL` | Não | Padrão: `https://euapi.ttlock.com/oauth2/token` |
| `TTLOCK_API_BASE_URL` | Não | Padrão: `https://euapi.ttlock.com` |

Para scripts de provisionamento que usam o banco (migrations 0006 e 0007 devem estar aplicadas no projeto Supabase):

| Env | Descrição |
|-----|-----------|
| `SUPABASE_URL` ou `NEXT_PUBLIC_SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service role (acesso total ao banco) |

## Como testar a autenticação

```bash
npm run debug:ttlock-auth
```

- Com as 4 envs TTLock preenchidas: obtém access token e exibe sucesso.
- Sem credenciais: exibe mensagem clara do que falta e sai com código 1.

## Como executar o provisionamento

**Todas as credenciais pendentes:**

```bash
npm run debug:ttlock-provision
```

**Uma credencial específica (id):**

```bash
npm run debug:ttlock-provision -- <uuid-da-credencial>
```

Com credenciais TTLock configuradas: chama a API para cada item pendente, atualiza status e persiste passcode/remote_keyboard_pwd_id.  
Sem credenciais: não quebra; marca itens com erro controlado e credencial como `falhou`, com mensagem explicativa.

## Campos novos (migration 0007)

- **operacional_credenciais_acesso**
  - `codigo_credencial`: passcode de 6 dígitos gerado para a credencial (reutilizado em todos os itens).
  - `provider_tipo`: `ttlock_passcode` (ou `ttlock_ekey` no futuro).

- **operacional_credencial_itens**
  - `remote_keyboard_pwd_id`: ID retornado pela TTLock (`keyboardPwdId`) para alteração/revogação futura.
  - `codigo_enviado`: cópia do passcode enviado a esta fechadura (suporte/debug).

## Fluxo

1. Ao liberar acesso no painel, o trigger (Fase 1) cria a credencial e os itens com status `pendente`.
2. Execução controlada (script ou futura rotina/backend) chama `processarCredencialDeAcesso(credencialId, deps)` ou `processarProvisionamentosPendentes(deps)`.
3. O executor gera um passcode (se ainda não existir), persiste em `codigo_credencial`, marca credencial como `provisionando`, e para cada item pendente chama TTLock `createKeyboardPassword` (addType=2, via gateway).
4. Para cada item: sucesso → `provisionado`, `provisionado_em`, `remote_keyboard_pwd_id`, `codigo_enviado`; falha → `falhou`, `ultimo_erro`.
5. Credencial: todos ok → `provisionada`; alguns falharam → `parcial`; todos falharam → `falhou`.

## Alteração e revogação

Stubs preparados no cliente: `updateKeyboardPassword`, `deleteKeyboardPassword`. Implementação prevista para fase seguinte.

## Dependência de credenciais reais

- **Autenticação e criação de passcode** dependem de credenciais válidas da TTLock (conta de aplicação Open Platform e app com permissões).
- Sem elas, o adaptador falha de forma controlada: não derruba o sistema, persiste erro nos itens e deixa a credencial em estado coerente (`falhou`), com mensagem clara no log e em `ultimo_erro`.
