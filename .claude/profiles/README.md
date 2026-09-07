# Perfis de permissao do Claude Code — Yes Hotel

O Claude Code le as permissoes de **`.claude/settings.json`**. Este diretorio guarda
tres versoes prontas desse arquivo e um script que faz a troca.

> **Regra que explica todo o desenho:** `deny` sempre vence `allow`, venha de onde vier
> (`settings.json`, `settings.local.json`, `--settings`, flag de linha de comando).
> Nao existe jeito de "liberar por cima" uma acao negada. Por isso o unico caminho para
> ampliar poder e **trocar o arquivo inteiro** — o que exige abrir outro atalho,
> conscientemente. Escalada de privilegio nunca acontece por acidente no meio de um chat.

---

## Os tres perfis

| Perfil | Modo | Serve para | Nao consegue |
|---|---|---|---|
| **Auditor** | `plan` | Ler, diagnosticar, propor. Estado de repouso do repositorio. | Editar arquivo, criar arquivo, qualquer git de escrita, rede, MCP |
| **Executor** | `acceptEdits` | Escrever codigo, rodar typecheck e testes locais | git de escrita, Supabase/Vercel/psql, TTLock, Pagar.me, DigiSac, HITS, rede |
| **Executor Total** | `bypassPermissions` | Refatoracao ampla sem confirmacao a cada passo | O **nucleo duro** (abaixo) continua bloqueado |

### O nucleo duro — bloqueado nos tres perfis, inclusive no Executor Total

| Dominio | Por que |
|---|---|
| **TTLock / fechaduras** | Provisionar, revogar, trocar senha, cleanup e retry mexem em **fechadura fisica de apartamento ocupado**. Erro aqui tranca hospede para fora. Irreversivel pelo chat. |
| **Supabase / psql / Vercel** | `db push`, `migration repair`, `db reset`, `functions deploy`, `secrets` — alteram producao. |
| **Pagar.me** | Link de pagamento real gera cobranca real. |
| **DigiSac / WhatsApp** | Envio real cai no celular de um hospede. Nao tem "desfazer". |
| **HITS / PMS** | Escrita de reserva contamina o sistema de gestao do hotel. |
| **`git push`, `git merge`, `gh`** | Publicacao. Sempre passa por voce. |
| **`.env`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.docx`** | Segredo lido e segredo vazado no transcript. |

Esses comandos **nao estao proibidos para voce** — estao proibidos para o agente.
Rode-os num terminal normal, com os olhos no que esta acontecendo.

---

## Como usar

Na raiz do repositorio:

```
claude-auditor.cmd          rem leitura e diagnostico  (padrao)
claude-executor.cmd         rem escrever codigo
claude-executor-total.cmd   rem pede confirmacao "SIM" antes de subir
```

Ao **fechar a sessao** de Executor ou Executor Total, o `finally` do script devolve
o repositorio ao Auditor sozinho. Se a janela morrer de forma anormal, a proxima
execucao de `claude-auditor.cmd` normaliza e avisa.

### Inspecionar sem subir o Claude

```powershell
.\.claude\profiles\Switch-ClaudeProfile.ps1 -ProfileName executor -NoLaunch
```

`-NoLaunch` aplica o perfil e sai. **Nao ha sessao, logo nao ha restauracao automatica** —
o script avisa isso na tela. Volte com `-ProfileName auditor -NoLaunch`.

---

## Guarda de integridade

Antes de trocar qualquer coisa, o script tira o SHA-256 de `.claude/settings.json` e
compara com os tres perfis conhecidos. Se nao bater com nenhum, ele **aborta sem
escrever**: significa que alguem editou o `settings.json` a mao, e sobrescrever apagaria
essa edicao em silencio. A mensagem de erro diz como sair do impasse.

---

## Arquivos

```
Switch-ClaudeProfile.ps1        troca o perfil, sobe o Claude, restaura o Auditor no fim
auditor.settings.json           perfil de leitura   (estado de repouso)
executor.settings.json          perfil de escrita de codigo
executor-total.settings.json    perfil amplo, com o nucleo duro preservado
README.md                       este arquivo
```

`.claude/settings.json` e sempre uma **copia** de um desses tres — nunca edite ele
diretamente. Edite o perfil de origem e reaplique.

`.claude/settings.local.json` (nao versionado, ignorado pelo git global) e pessoal e
so contem `allow`. Ele **nao consegue afrouxar** nada: `deny` vence. Fica como esta.

---

## Manutencao

Nao ha script de build nem de diff aqui. Os tres perfis sao JSON escritos a mao e lidos
a olho nu; um gerador acrescentaria uma camada a mais para manter sincronizada, com o
risco classico de o JSON versionado divergir do gerador. Para conferir a diferenca entre
dois perfis, o git ja resolve:

```powershell
git diff --no-index .claude\profiles\auditor.settings.json .claude\profiles\executor.settings.json
```

**Ao adicionar um script novo de risco ao `package.json`**, acrescente a regra `deny`
correspondente nos tres perfis — em `Bash(...)` **e** em `PowerShell(...)`, porque as
duas ferramentas existem e o `deny` de uma nao cobre a outra.
