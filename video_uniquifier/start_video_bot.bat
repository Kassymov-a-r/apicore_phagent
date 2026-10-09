@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set "VIDEO_PYTHON=%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
cd /d "%~dp0"
if not exist "%VIDEO_PYTHON%" (
  echo Python 3.12 not found in the location used by APICORE.BOT.
  echo Install Python 3.12 for the current user, then run this file again.
  pause
  exit /b 1
)
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo Created .env. Set a NEW Telegram bot token and ALLOWED_USER_IDS.
  start /wait notepad.exe ".env"
)
if exist "tools\ffmpeg\bin\ffmpeg.exe" set "PATH=%~dp0tools\ffmpeg\bin;%PATH%"
if exist "tools\ffmpeg.exe" set "PATH=%~dp0tools;%PATH%"
"%VIDEO_PYTHON%" -m uniquifier.bot
pause
