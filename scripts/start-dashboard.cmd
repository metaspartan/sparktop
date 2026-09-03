@echo off
rem Start the sparktop web dashboard (http://localhost:5757).
rem Works from any location; appends output to server.log in the repo root.
rem The server resolves config/nodes.json from the repo root on its own.
cd /d "%~dp0.."
bun run start >> "%~dp0..\server.log" 2>&1
