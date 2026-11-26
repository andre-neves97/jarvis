@echo off
rem Jarvis launcher: sets itself up on first run, then starts the server and opens the browser.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Setting up Python environment...
  python -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install -q -r backend\requirements.txt || goto :error
)

if not exist "frontend\dist\index.html" (
  echo Building the interface...
  pushd frontend
  call npm install --silent || goto :error
  call npm run build --silent || goto :error
  popd
)

start "" http://127.0.0.1:8765
".venv\Scripts\python.exe" backend\server.py
goto :eof

:error
echo.
echo Jarvis could not start. See the message above.
pause
