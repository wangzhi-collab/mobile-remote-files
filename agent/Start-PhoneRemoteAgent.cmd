@echo off
setlocal
title Phone Remote Agent
cd /d "%~dp0"
if "%PHONE_REMOTE_SERVER_URL%"=="" set "PHONE_REMOTE_SERVER_URL=https://your-domain.example"
start "" "%~dp0PhoneRemoteAgent.exe" "%PHONE_REMOTE_SERVER_URL%"
exit /b
