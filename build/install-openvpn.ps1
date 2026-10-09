param([string]$RuntimeDirectory = $PSScriptRoot, [switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
Import-Module Microsoft.PowerShell.Utility, Microsoft.PowerShell.Security, Microsoft.PowerShell.Management
$log = Join-Path $env:TEMP 'DropoVPN-OpenVPN-setup.log'
try {
  $manifest = Get-Content -LiteralPath (Join-Path $RuntimeDirectory 'manifest.json') -Raw | ConvertFrom-Json
  $msi = Join-Path $RuntimeDirectory 'OpenVPN.msi'
  if ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ne $manifest.sha256) { throw 'The bundled OpenVPN installer failed its checksum check.' }
  $signature = Get-AuthenticodeSignature -LiteralPath $msi
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenVPN') { throw 'The bundled OpenVPN installer does not have a valid OpenVPN signature.' }
  if ($VerifyOnly) { Write-Host 'OpenVPN MSI checksum and publisher signature verified.'; exit 0 }
  $nativeProgramFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $binary = Join-Path $nativeProgramFiles 'OpenVPN\bin\openvpn.exe'
  $driverReady = Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Services\tap0901'
  if (Test-Path -LiteralPath $binary) {
    $versionText = (& $binary --version 2>&1 | Out-String)
    if ($versionText -match 'OpenVPN (2\.\d+\.\d+)' -and [version]($Matches[1]) -ge [version]$manifest.version -and $driverReady) {
      Write-Host 'A compatible OpenVPN engine and TAP driver are already installed.'
      exit 0
    }
  }
  # Use the upstream MSI to register its signed driver and shared runtime.
  # Leave other OpenVPN applications and their configuration under MSI control.
  $arguments = @('/i', ('"' + $msi + '"'), '/qn', '/norestart', 'ADDLOCAL=OpenVPN,Drivers,Drivers.TAPWindows6', '/L*v', ('"' + $log + '"'))
  $setup = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList $arguments -Wait -PassThru
  $result = $setup.ExitCode
  if ($result -notin @(0,3010,1641)) { throw "OpenVPN setup failed with code $result. See $log. Close other installers and run DropoVPN setup again." }
  if (-not (Test-Path -LiteralPath $binary)) { throw "OpenVPN setup finished but its executable is missing. See $log." }
  $versionText = (& $binary --version 2>&1 | Out-String)
  if ($versionText -notmatch 'OpenVPN 2\.([6-9]|[1-9][0-9]+)\.') { throw 'The installed OpenVPN engine could not start.' }
  if (-not (Test-Path 'HKLM:\SYSTEM\CurrentControlSet\Services\tap0901')) { throw "The required TAP network driver is missing. See $log." }
  Write-Host 'OpenVPN engine and network driver installed.'
  exit $result
} catch {
  Write-Error $_ -ErrorAction Continue
  exit 1
}
