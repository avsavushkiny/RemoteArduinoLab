@echo off
setlocal
title Remote Arduino Lab - Add User
cd /d "%~dp0"

echo ==========================================
echo Remote Arduino Lab - Add User
echo ==========================================
echo.

if not exist "manage-users.js" (
    echo ERROR: manage-users.js was not found.
    echo Save this BAT file in the project folder next to manage-users.js.
    echo.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js was not found. Install Node.js first.
    echo.
    pause
    exit /b 1
)

echo Choose account type:
echo   1. Student
echo   2. Teacher / Administrator
echo   0. Exit
echo.
set "ROLECHOICE="
set /p "ROLECHOICE=Your choice: "

if "%ROLECHOICE%"=="1" (
    set "ROLE=student"
    goto ask_username
)
if "%ROLECHOICE%"=="2" (
    set "ROLE=admin"
    goto ask_username
)
if "%ROLECHOICE%"=="0" exit /b 0

echo Invalid choice.
pause
exit /b 1

:ask_username
echo.
set "NEWUSER="
set /p "NEWUSER=Enter the new user's login: "

if not defined NEWUSER (
    echo Login cannot be empty.
    pause
    exit /b 1
)

echo.
echo Account: %NEWUSER%
if "%ROLE%"=="student" echo Role: Student
if "%ROLE%"=="admin" echo Role: Teacher / Administrator
echo.
echo The user-management script will ask for a password.
echo Use a password of at least 12 characters.
echo.
set "CONFIRM="
set /p "CONFIRM=Continue? (Y/N): "

if /i not "%CONFIRM%"=="Y" (
    echo Cancelled.
    pause
    exit /b 0
)

echo.
node manage-users.js add "%NEWUSER%" "%ROLE%"
set "RESULT=%ERRORLEVEL%"

echo.
if "%RESULT%"=="0" (
    echo Command finished. Check the message above to confirm success.
) else (
    echo ERROR: Could not add the user. Check the message above.
)
echo.
pause
exit /b %RESULT%
