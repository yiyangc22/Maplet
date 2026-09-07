@echo off
setlocal
rem Cellmap Viewer launcher (Windows) - double-click to run the Electron app.
rem (No install needed just to VIEW data: double-click CellmapViewer.html instead.)
cd /d "%~dp0"

rem Prefer a portable Node bundled in the folder, else system Node on PATH.
set "BUNDLED=%~dp0tools\node\win-x64"
if exist "%BUNDLED%\node.exe" set "PATH=%BUNDLED%;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo(
  echo   No Node.js found. Either:
  echo     - just double-click CellmapViewer.html ^(runs in your browser, no install^), or
  echo     - install Node 18+ from https://nodejs.org/ , or
  echo     - drop a portable Node into tools\node\win-x64\ ^(so node.exe is there^).
  echo(
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist" (
  echo First run: installing dependencies. This can take a few minutes...
  call npm install --no-fund --no-audit
  if errorlevel 1 goto fail
)

if not exist "dist\index.html" (
  echo First run: building the app...
  call npm run build
  if errorlevel 1 goto fail
)

start "Cellmap Viewer" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
echo(
echo Setup failed. See the messages above.
pause
exit /b 1
