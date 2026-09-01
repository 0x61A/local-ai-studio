@echo off
REM Local AI Studio - Windows baslatici. Cift tiklayin.
REM Tek isi start.ps1'i calistirmak: PowerShell betikleri varsayilan
REM ExecutionPolicy ile acilmaz, bayrak burada veriliyor.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
