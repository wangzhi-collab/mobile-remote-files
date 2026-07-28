@echo off
setlocal
title Install Phone Remote Agent

set "INSTALL_DIR=%LOCALAPPDATA%\PhoneRemoteAgent"
set "DESKTOP=%USERPROFILE%\Desktop"

echo Installing Phone Remote Agent...
echo Target: %INSTALL_DIR%

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
copy /Y "%~dp0PhoneRemoteAgent.exe" "%INSTALL_DIR%\PhoneRemoteAgent.exe" >nul
copy /Y "%~dp0Start-PhoneRemoteAgent.cmd" "%INSTALL_DIR%\Start-PhoneRemoteAgent.cmd" >nul

if "%PHONE_REMOTE_SERVER_URL%"=="" set "PHONE_REMOTE_SERVER_URL=https://your-domain.example"

powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%DESKTOP%\Phone Remote Agent.lnk'); $s.TargetPath='%INSTALL_DIR%\PhoneRemoteAgent.exe'; $s.Arguments='""%PHONE_REMOTE_SERVER_URL%""'; $s.WorkingDirectory='%INSTALL_DIR%'; $s.Description='Phone Remote Agent'; $s.IconLocation='%INSTALL_DIR%\PhoneRemoteAgent.exe,0'; $s.Save()"

echo.
echo Installed successfully.
echo A shortcut named "Phone Remote Agent" has been created on the desktop.
echo Double-click it. A PIN pairing window will appear automatically.
echo.
pause
