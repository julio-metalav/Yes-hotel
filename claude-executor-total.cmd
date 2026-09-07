@echo off
setlocal
echo.
echo  ==========================================================
echo   YES HOTEL - EXECUTOR TOTAL
echo  ==========================================================
echo.
echo   Este perfil roda em bypassPermissions: o Claude NAO vai
echo   pedir confirmacao para editar arquivos nem rodar comandos.
echo.
echo   Seguem BLOQUEADOS mesmo aqui:
echo     - TTLock (provisionar, revogar, senha, cleanup, retry)
echo     - Supabase / psql / Vercel  (deploy, migration, reset)
echo     - Pagar.me (link de pagamento real)
echo     - DigiSac / WhatsApp (envio real a hospede)
echo     - HITS / PMS (escrita real de reserva)
echo     - git push, git merge, gh
echo     - leitura de .env, chaves e certificados
echo.
echo   Ao fechar a sessao o repositorio volta sozinho ao AUDITOR.
echo.
set /p "CONFIRMA=  Digite SIM para continuar: "
if /I not "%CONFIRMA%"=="SIM" (
  echo.
  echo   Cancelado. Nada foi alterado.
  echo.
  endlocal
  exit /b 1
)
endlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0.claude\profiles\Switch-ClaudeProfile.ps1" -ProfileName executor-total %*
