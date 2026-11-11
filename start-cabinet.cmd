@echo off
chcp 65001 >nul
set "NoDefaultCurrentDirectoryInExePath=1"
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Позовите тренера: Node.js ставит ИТ.
  pause
  exit /b 1
)
echo Окно не закрывайте, пока работаете со страницей. Закрыли окно: страница остановится.
node tools\serve.mjs --open
echo.
echo Страница остановлена. Чтобы открыть её снова, запустите start-cabinet.cmd ещё раз.
pause
