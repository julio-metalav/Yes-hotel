@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0.claude\profiles\Switch-ClaudeProfile.ps1" -ProfileName executor %*
