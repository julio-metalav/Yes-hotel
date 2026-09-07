<#
.SYNOPSIS
    Alterna o perfil de permissoes do Claude Code no repositorio Yes Hotel.

.DESCRIPTION
    O Claude Code le as permissoes de .claude/settings.json. Este script troca
    esse arquivo pelo perfil pedido, sobe o Claude e, ao final da sessao,
    devolve o repositorio ao estado de repouso (Auditor).

    Regra de ouro: deny sempre vence allow, em qualquer fonte. Por isso o unico
    jeito de liberar uma acao negada e trocar o arquivo de settings inteiro --
    e nao existe flag de linha de comando que contorne isso.

.PARAMETER ProfileName
    auditor | executor | executor-total

.PARAMETER NoLaunch
    Aplica o perfil e sai, sem subir o Claude. Usado para teste e inspecao.
    ATENCAO: como nao ha sessao, tambem nao ha restauracao automatica --
    o perfil aplicado permanece ate a proxima troca.

.EXAMPLE
    .\Switch-ClaudeProfile.ps1 -ProfileName executor
    .\Switch-ClaudeProfile.ps1 -ProfileName auditor -NoLaunch
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('auditor', 'executor', 'executor-total')]
    [string]$ProfileName,

    [switch]$NoLaunch,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArgs
)

$ErrorActionPreference = 'Stop'

# Caminhos derivados da propria localizacao do script -- independentes do cwd.
$ProfilesDir = $PSScriptRoot
$RepoRoot    = Split-Path -Parent (Split-Path -Parent $ProfilesDir)
$Target      = Join-Path $RepoRoot '.claude\settings.json'

$Known = @{
    'auditor'        = Join-Path $ProfilesDir 'auditor.settings.json'
    'executor'       = Join-Path $ProfilesDir 'executor.settings.json'
    'executor-total' = Join-Path $ProfilesDir 'executor-total.settings.json'
}

foreach ($k in $Known.Keys) {
    if (-not (Test-Path -LiteralPath $Known[$k])) {
        Write-Host "ERRO: perfil ausente -> $($Known[$k])" -ForegroundColor Red
        exit 1
    }
}

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Resolve-CurrentProfile {
    $h = Get-Sha256 $Target
    if ($null -eq $h) { return $null }
    foreach ($k in $Known.Keys) {
        if ((Get-Sha256 $Known[$k]) -eq $h) { return $k }
    }
    return 'DESCONHECIDO'
}

function Set-Profile([string]$Name) {
    Copy-Item -LiteralPath $Known[$Name] -Destination $Target -Force
}

function Restore-Auditor {
    try {
        Set-Profile 'auditor'
        Write-Host ''
        Write-Host '[perfil] Repositorio devolvido ao estado de repouso: AUDITOR.' -ForegroundColor DarkGray
    } catch {
        Write-Host ''
        Write-Host '[perfil] FALHA AO RESTAURAR O AUDITOR. Rode manualmente:' -ForegroundColor Red
        Write-Host '         .\.claude\profiles\Switch-ClaudeProfile.ps1 -ProfileName auditor -NoLaunch' -ForegroundColor Red
    }
}

# --- Guarda de integridade -------------------------------------------------
# Se settings.json nao bate com nenhum perfil conhecido, foi editado a mao.
# Sobrescrever apagaria essa edicao em silencio, entao abortamos.
$current = Resolve-CurrentProfile

if ($current -eq 'DESCONHECIDO') {
    Write-Host ''
    Write-Host 'ERRO: .claude/settings.json nao corresponde a nenhum perfil conhecido.' -ForegroundColor Red
    Write-Host 'Provavelmente foi editado manualmente. Nada foi alterado.' -ForegroundColor Red
    Write-Host ''
    Write-Host 'Para retomar o controle, escolha uma das opcoes:' -ForegroundColor Yellow
    Write-Host '  1. Preserve sua edicao copiando-a para .claude/profiles/ como um perfil novo;' -ForegroundColor Yellow
    Write-Host '  2. Ou descarte-a copiando auditor.settings.json sobre .claude/settings.json.' -ForegroundColor Yellow
    exit 1
}

if ($null -eq $current) {
    Write-Host '[perfil] .claude/settings.json ausente. Criando a partir do AUDITOR.' -ForegroundColor Yellow
    Set-Profile 'auditor'
    $current = 'auditor'
}

# Sessao anterior morta abruptamente (crash, fechar a janela no X) deixa o
# repositorio em executor. Normaliza antes de seguir.
if ($current -ne 'auditor' -and $ProfileName -eq 'auditor') {
    Write-Host "[perfil] Estado anterior era '$current'. Normalizando para AUDITOR." -ForegroundColor Yellow
}

Set-Profile $ProfileName

$banner = switch ($ProfileName) {
    'auditor'        { @{ Text = 'AUDITOR -- somente leitura, modo plan'; Color = 'Cyan' } }
    'executor'       { @{ Text = 'EXECUTOR -- edita codigo; sem git de escrita, sem Supabase, sem TTLock real'; Color = 'Yellow' } }
    'executor-total' { @{ Text = 'EXECUTOR TOTAL -- permissoes amplas; TTLock/Pagar.me/DigiSac/HITS/push seguem BLOQUEADOS'; Color = 'Red' } }
}

Write-Host ''
Write-Host "[perfil] $($banner.Text)" -ForegroundColor $banner.Color
Write-Host "[perfil] repo: $RepoRoot" -ForegroundColor DarkGray

if ($NoLaunch) {
    Write-Host '[perfil] -NoLaunch: perfil aplicado, Claude nao foi iniciado.' -ForegroundColor DarkGray
    if ($ProfileName -ne 'auditor') {
        Write-Host '[perfil] AVISO: sem sessao nao ha restauracao automatica. Rode com -ProfileName auditor -NoLaunch quando terminar.' -ForegroundColor Yellow
    }
    exit 0
}

if ($ProfileName -eq 'auditor') {
    # Auditor ja e o estado de repouso: nada a restaurar depois.
    & claude @ClaudeArgs
    exit $LASTEXITCODE
}

try {
    & claude @ClaudeArgs
} finally {
    Restore-Auditor
}
