@echo off
:: Cria tarefa no Windows Task Scheduler para rodar o scraper diariamente às 08:00
:: Execute este arquivo como Administrador (clique direito → Executar como administrador)

set "PASTA=%~dp0"
set "HORA=08:00"
set "NOME_TAREFA=WAT-ImoveisItu"

schtasks /create ^
  /tn "%NOME_TAREFA%" ^
  /tr "cmd /c cd /d \"%PASTA%\" && npm run scrape >> logs\scraper.log 2>&1" ^
  /sc daily ^
  /st %HORA% ^
  /f

if %errorlevel% == 0 (
  echo.
  echo Tarefa "%NOME_TAREFA%" criada com sucesso!
  echo Rodará todos os dias às %HORA%.
  echo Para alterar o horário, edite HORA neste arquivo e rode novamente.
) else (
  echo.
  echo Falha ao criar tarefa. Execute como Administrador.
)

pause
