<#
Creates SMARTCheck's self-signed code-signing certificate on this PC, in your Windows certificate
store (Current User > Personal), where `npm run build:brand` finds it and signs with it.

  powershell -ExecutionPolicy Bypass -File scripts\signing\new-cert.ps1 [-Publisher "Name"] [-Years 5] [-Force]

-Publisher  the name Windows shows as "Verified publisher" (default "SMARTCheck (internal)")
-Force      make a new certificate even if a valid one exists (e.g. to change the name);
            PCs that trusted the old one need the new one installed too

The certificate can only sign code (it can't act as a certificate authority or secure websites),
so trusting it on a PC trusts only programs signed with it.

The private key stays in the certificate store. To back it up, or to sign on another PC:
certmgr.msc > Personal > Certificates > "SMARTCheck code signing" > All Tasks > Export,
with the private key and a password. Keep that file private.
#>
param(
  [string]$Publisher = "SMARTCheck (internal)",
  [int]$Years = 5,
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$friendly = "SMARTCheck code signing"

$existing = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.FriendlyName -eq $friendly -and $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending | Select-Object -First 1
if ($existing -and -not $Force) {
  Write-Host "A SMARTCheck signing certificate already exists:"
  Write-Host "  $($existing.Subject), valid until $($existing.NotAfter.ToString('d MMM yyyy')), thumbprint $($existing.Thumbprint)"
  Write-Host "Use -Force to make a new one."
  exit 0
}

$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=$Publisher" -FriendlyName $friendly `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears($Years) `
  -TextExtension @("2.5.29.19={critical}{text}ca=0")

Write-Host "Created the SMARTCheck signing certificate:"
Write-Host "  $($cert.Subject), valid until $($cert.NotAfter.ToString('d MMM yyyy')), thumbprint $($cert.Thumbprint)"
Write-Host "npm run build:brand will now sign installers with it."
