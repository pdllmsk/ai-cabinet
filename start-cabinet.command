#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Не найден Node.js. Позовите тренера: Node.js ставит ИТ."
  read -r -p "Нажмите Enter, чтобы закрыть окно."
  exit 1
fi
echo "Окно не закрывайте, пока работаете со страницей. Закрыли окно: страница остановится."
node tools/serve.mjs --open
echo
echo "Страница остановлена. Чтобы открыть её снова, запустите start-cabinet.command ещё раз."
read -r -p "Нажмите Enter, чтобы закрыть окно."
