@echo off
setlocal
cd /d "%~dp0"
echo === Remote Arduino Lab ===
node --version
if errorlevel 1 (
  echo Node.js не найден. Установите Node.js 18 или новее.
  pause
  exit /b 1
)
"C:\ffmpeg\bin\ffmpeg.exe" -version >nul 2>&1
if errorlevel 1 (
  echo FFmpeg не найден по пути C:\ffmpeg\bin\ffmpeg.exe
  echo Исправьте ffmpegPath в config.js, если он установлен в другом месте.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Установка зависимостей...
  call npm install
  if errorlevel 1 (echo Ошибка установки зависимостей.& pause & exit /b 1)
)
call npm start
pause
