@echo off
setlocal
rem Trusts the SMARTCheck signing certificate on this PC, so SMARTCheck's installers and app show
rem "Verified publisher: __PUBLISHER__" instead of "Unknown publisher". Run once per PC.
rem It needs administrator rights and SMARTCheck-signing.cer in the same folder.
rem
rem The certificate can only sign programs; it can't act as a certificate authority or for websites.
rem To undo, in an administrator Command Prompt:
rem   certutil -delstore Root __THUMBPRINT__
rem   certutil -delstore TrustedPublisher __THUMBPRINT__

net session >nul 2>&1
if errorlevel 1 (
  echo Asking for administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set "CER=%~dp0SMARTCheck-signing.cer"
if not exist "%CER%" (
  echo SMARTCheck-signing.cer must be in the same folder as this file.
  pause
  exit /b 1
)
certutil -f -addstore Root "%CER%" >nul
if errorlevel 1 goto failed
certutil -f -addstore TrustedPublisher "%CER%" >nul
if errorlevel 1 goto failed
echo Done. Programs signed by __PUBLISHER__ are now trusted on this PC.
pause
exit /b 0

:failed
echo Couldn't add the certificate. Try right-clicking this file and choosing "Run as administrator".
pause
exit /b 1
