@echo off
rem ============================================================
rem  LaunchPad Agent - quick launcher
rem  Starts Chrome with the extension loaded and opens the
rem  LaunchPad dashboard. Note: --load-extension lasts for this
rem  Chrome session; for a permanent install do it once manually:
rem  chrome://extensions -> Developer mode -> Load unpacked ->
rem  select this folder.
rem ============================================================
setlocal
set "EXT_DIR=%~dp0"
if "%EXT_DIR:~-1%"=="\" set "EXT_DIR=%EXT_DIR:~0,-1%"

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not defined CHROME (
  echo Could not find chrome.exe - install the extension manually:
  echo   chrome://extensions -^> Developer mode -^> Load unpacked -^> select this folder
  pause
  exit /b 1
)

echo Launching Chrome with LaunchPad Agent loaded...
start "" "%CHROME%" --load-extension="%EXT_DIR%" "http://localhost:3000"
echo.
echo If the extension icon does not appear (recent Chrome versions block
echo --load-extension), install it permanently instead:
echo   chrome://extensions -^> Developer mode -^> Load unpacked -^> select:
echo   %EXT_DIR%
endlocal
