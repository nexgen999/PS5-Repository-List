@echo off
:: Lance PowerShell, exécute les commandes à la suite et garde la fenêtre ouverte
powershell -NoExit -Command "Set-ExecutionPolicy Unrestricted -Scope Process; cd pegasus-resolver; .\venv\Scripts\Activate.ps1; pegasus-resolver --host 192.168.1.18 --port 7799"