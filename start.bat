@echo off
rem ==========================================================================
rem  Image Forge - one-click launcher for Windows 10 / 11
rem
rem  Double-click this file. On any PC it checks everything Image Forge
rem  needs, fetches whatever is missing, and starts the app:
rem
rem    1. Windows 10 or newer, 64-bit (x64 or ARM64)
rem    2. Node.js 22.13 or newer - when the PC has none, or an older one, a
rem       private copy of the current LTS is downloaded into .runtime\
rem       (no installer, no admin rights, nothing changed system-wide; the
rem       download is checked against the SHA-256 that nodejs.org publishes)
rem    3. npm, which ships with Node.js
rem    4. The npm packages from package-lock.json: sharp (image engine),
rem       pdf-lib (builds PDFs), pdfjs-dist + @napi-rs/canvas (renders PDFs).
rem       Installed when missing; reinstalled when broken or out of date.
rem    5. A working install, proven by scripts\doctor.js actually running
rem       every engine - not just by the files being present
rem    6. A free port; then the server starts and the browser opens
rem
rem  Usage:  start.bat            check, install what is missing, run
rem          start.bat --check    check and install only, do not start
rem
rem  Only steps 2 and 4 need the internet, and only the first time.
rem ==========================================================================
setlocal EnableExtensions DisableDelayedExpansion
title Image Forge

rem pushd, unlike cd, also works when the folder is on a network share.
pushd "%~dp0" || (echo   Cannot open the folder this script is in. & pause & exit /b 1)

set "MIN_NODE_MAJOR=22"
set "MIN_NODE_MINOR=13"
set "RUNTIME_DIR=%CD%\.runtime"
set "PORTABLE_NODE=%RUNTIME_DIR%\node"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "CHECK_ONLY="
if /i "%~1"=="--check" set "CHECK_ONLY=1"

echo.
echo   Image Forge
echo   -----------
echo.

rem --- 1. Windows version and processor ------------------------------------

rem `ver` prints e.g. "Microsoft Windows [Version 10.0.26100.4652]".
set "WIN_MAJOR="
set "WIN_BUILD=0"
for /f "tokens=4-6 delims=[]. " %%a in ('ver') do if not defined WIN_MAJOR (
  set "WIN_MAJOR=%%a"
  set "WIN_BUILD=%%c"
)
set "WIN_NAME=Windows"
if not defined WIN_MAJOR goto :windows_checked
if %WIN_MAJOR% LSS 10 (
  set "FAIL_MSG=Windows 10 or newer is required. Node.js no longer runs on older versions."
  goto :fail
)
rem Windows 11 still calls itself 10.0; its builds start at 22000.
set "WIN_NAME=Windows %WIN_MAJOR%"
if %WIN_MAJOR% EQU 10 if %WIN_BUILD% GEQ 22000 set "WIN_NAME=Windows 11"
set "WIN_NAME=%WIN_NAME% build %WIN_BUILD%"
:windows_checked

rem A 32-bit cmd.exe on 64-bit Windows reports x86; the real answer is here.
set "CPU=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "CPU=%PROCESSOR_ARCHITEW6432%"
set "NODE_ARCH="
if /i "%CPU%"=="AMD64" set "NODE_ARCH=x64"
if /i "%CPU%"=="ARM64" set "NODE_ARCH=arm64"
if not defined NODE_ARCH (
  set "FAIL_MSG=64-bit Windows is required - this PC reports a %CPU% processor."
  goto :fail
)
echo   [ok] %WIN_NAME%, %NODE_ARCH%

rem --- 2. Node.js ------------------------------------------------------------

rem A Node.js already on PATH is used when it is new enough...
call :node_ok node
if not errorlevel 1 goto :node_ready

rem ...then a private copy downloaded on an earlier run...
if not exist "%PORTABLE_NODE%\node.exe" goto :node_download
call :node_ok "%PORTABLE_NODE%\node.exe"
if not errorlevel 1 goto :node_use_portable

:node_download
rem ...and failing both, a fresh one.
if defined NODE_VERSION (
  echo   [..] Node.js %NODE_VERSION% is too old - %MIN_NODE_MAJOR%.%MIN_NODE_MINOR% or newer is needed.
) else (
  echo   [..] Node.js is not installed.
)
echo        Downloading a private copy into .runtime\ - your system is not changed.
if not exist "%POWERSHELL%" (
  set "FAIL_MSG=Windows PowerShell is missing, so Node.js cannot be downloaded. Install Node.js %MIN_NODE_MAJOR% LTS from https://nodejs.org and run this again."
  goto :fail
)
set "IF_SELF=%~f0"
set "IF_RUNTIME=%RUNTIME_DIR%"
set "IF_ARCH=%NODE_ARCH%"
set "IF_MIN=%MIN_NODE_MAJOR%.%MIN_NODE_MINOR%.0"
rem Started from a PowerShell 7 window, Windows PowerShell inherits a module
rem path that hides some of its own commands; let it use its defaults.
set "PSModulePath="
rem Runs the PowerShell section at the end of this file. The marker is split
rem in two so that this line does not contain it and match itself.
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -Command "$code = [IO.File]::ReadAllText($env:IF_SELF); & ([ScriptBlock]::Create($code.Substring($code.IndexOf('#' + '<powershell>'))))"
if errorlevel 1 (
  set "FAIL_MSG=Node.js could not be downloaded. Check the internet connection or proxy, or install Node.js %MIN_NODE_MAJOR% LTS from https://nodejs.org and run this again."
  goto :fail
)
call :node_ok "%PORTABLE_NODE%\node.exe"
if errorlevel 1 (
  set "FAIL_MSG=The downloaded Node.js does not run on this PC."
  goto :fail
)

:node_use_portable
set "PATH=%PORTABLE_NODE%;%PATH%"

:node_ready
echo   [ok] Node.js %NODE_VERSION%

rem --- 3. npm ----------------------------------------------------------------

rem npm is a .cmd script: without `call`, this file would stop when it ends.
set "NPM_VERSION="
for /f "delims=" %%v in ('call npm --version 2^>nul') do set "NPM_VERSION=%%v"
if not defined NPM_VERSION (
  set "FAIL_MSG=npm did not run. Reinstall Node.js from https://nodejs.org, or delete the .runtime folder and run this again."
  goto :fail
)
echo   [ok] npm %NPM_VERSION%

rem --- 4 and 5. Packages, proven working -------------------------------------

rem Behind a TLS-inspecting proxy, PowerShell trusts the Windows certificate
rem store but Node.js only its own bundle; this makes npm trust the same CAs.
set "NODE_USE_SYSTEM_CA=1"

if not exist "node_modules\" (
  echo   [..] Packages are not installed yet.
  goto :deps_install
)
node scripts\doctor.js --quiet >nul 2>&1
if not errorlevel 1 goto :deps_ready
echo   [..] Some packages are missing, broken or out of date.

:deps_install
echo        Installing from package-lock.json - the first time this downloads
echo        about 60 MB and takes a minute or two...
call npm ci --no-audit --no-fund --loglevel=error
if not errorlevel 1 goto :deps_ready
echo        npm ci did not finish - trying npm install instead.
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  set "FAIL_MSG=The packages could not be installed. Check the internet connection or proxy. If another Image Forge window is open, close it first - Windows locks files that are in use."
  goto :fail
)

:deps_ready
echo.
node scripts\doctor.js
if errorlevel 1 (
  set "FAIL_MSG=A dependency is not working - see the FAIL lines above. Deleting the node_modules folder and running this again usually fixes it."
  goto :fail
)

rem --- 6. Start -----------------------------------------------------------

if defined CHECK_ONLY (
  echo   Everything is ready. Run start.bat without --check to start Image Forge.
  goto :done
)
node scripts\launch.js
if errorlevel 1 (
  set "FAIL_MSG=Image Forge stopped with an error - see the message above."
  goto :fail
)
goto :done

rem ==========================================================================

:node_ok
rem Succeeds when %1 runs and reports Node.js MIN_NODE_MAJOR.MIN_NODE_MINOR or
rem newer; sets NODE_VERSION to whatever it reported. `call` stops cmd from
rem mangling the quotes when %1 is a quoted path.
set "NODE_VERSION="
for /f "delims=" %%v in ('call "%~1" -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%v"
if not defined NODE_VERSION exit /b 1
for /f "tokens=1,2 delims=." %%a in ("%NODE_VERSION%") do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if %NODE_MAJOR% GTR %MIN_NODE_MAJOR% exit /b 0
if %NODE_MAJOR% LSS %MIN_NODE_MAJOR% exit /b 1
if %NODE_MINOR% GEQ %MIN_NODE_MINOR% exit /b 0
exit /b 1

:fail
echo.
echo   [X] %FAIL_MSG%
echo.
popd
pause
exit /b 1

:done
popd
endlocal
exit /b 0

rem Everything below the marker is PowerShell, run by step 2 above; cmd never
rem reaches it. It reads its settings from the IF_* environment variables.

#<powershell>
$ErrorActionPreference = 'Stop'
# Windows PowerShell's progress bar slows downloads down several times over.
$ProgressPreference = 'SilentlyContinue'
# Older Windows builds do not offer TLS 1.2 by default; nodejs.org needs it.
[Net.ServicePointManager]::SecurityProtocol =
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
# Use the system proxy with the signed-in user's credentials, as browsers do.
[Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultCredentials

function Get-Sha256($path) {
  # .NET directly: Get-FileHash is missing from some PowerShell setups.
  $stream = [IO.File]::OpenRead($path)
  try {
    [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-', '')
  } finally {
    $stream.Dispose()
  }
}

try {
  $dist = 'https://nodejs.org/dist'
  $arch = $env:IF_ARCH
  $runtime = $env:IF_RUNTIME
  $minimum = [version]$env:IF_MIN

  Write-Host '       Finding the current Node.js LTS release...'
  # Held in a variable first: Windows PowerShell 5.1 pipes a JSON array from
  # Invoke-RestMethod as one object instead of enumerating its elements.
  $releases = Invoke-RestMethod -UseBasicParsing "$dist/index.json"
  $release = $releases |
    Where-Object {
      $_.lts -and ($_.files -contains "win-$arch-zip") -and
      ([version]$_.version.TrimStart('v') -ge $minimum)
    } |
    Select-Object -First 1
  if (-not $release) { throw "nodejs.org lists no LTS release for win-$arch." }

  $version = $release.version
  $name = "node-$version-win-$arch"
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $zip = Join-Path $runtime "$name.zip"
  $sums = Join-Path $runtime 'SHASUMS256.txt'

  # The checksum comes first, so a complete download left by an interrupted
  # earlier run can be verified and reused instead of fetched again.
  Invoke-WebRequest -UseBasicParsing "$dist/$version/SHASUMS256.txt" -OutFile $sums
  $line = Get-Content $sums | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))$" } |
    Select-Object -First 1
  if (-not $line) { throw "nodejs.org publishes no checksum for $name.zip." }
  $expected = ($line -split '\s+')[0].ToUpperInvariant()

  if ((Test-Path $zip) -and (Get-Sha256 $zip) -eq $expected) {
    Write-Host "       Reusing the Node.js $version download from an earlier run."
  } else {
    Write-Host "       Downloading Node.js $version ($arch, about 30 MB)..."
    Invoke-WebRequest -UseBasicParsing "$dist/$version/$name.zip" -OutFile $zip
    if ((Get-Sha256 $zip) -ne $expected) {
      Remove-Item $zip -Force
      throw "$name.zip does not match its published SHA-256 - the download is damaged or was altered."
    }
  }
  Write-Host '       Checksum verified. Unpacking...'

  $staging = Join-Path $runtime 'staging'
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  # tar.exe (built into Windows 10 1803+) is far faster than Expand-Archive.
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    & $tar -xf $zip -C $staging
    if ($LASTEXITCODE -ne 0) { throw "tar could not unpack $name.zip." }
  } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
  }

  $target = Join-Path $runtime 'node'
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Move-Item (Join-Path $staging $name) $target
  Remove-Item $staging -Recurse -Force
  Remove-Item $zip, $sums -Force
  Write-Host "       Node.js $version is ready in .runtime\node"
  exit 0
} catch {
  Write-Host "       $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
