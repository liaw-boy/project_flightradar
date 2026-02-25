@echo off
title Stop FlightRadar Server
echo =======================================
echo     Stopping Flightradar Server
echo =======================================
taskkill /F /IM node.exe /T
echo Server stopped successfully.
pause
