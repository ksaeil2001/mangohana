[CmdletBinding()]
param(
  [string]$CkaUrl = $env:TRIO_ESIGNER_CKA_URL,
  [string]$ExpectedSha256 = $env:TRIO_ESIGNER_CKA_SHA256,
  [string]$ExpectedPublisherSubject = $env:TRIO_WINDOWS_PUBLISHER_SUBJECT
)

$ErrorActionPreference = "Stop"

function Stop-Safely([string]$Message) {
  throw $Message
}

if ([string]::IsNullOrWhiteSpace($CkaUrl)) {
  Stop-Safely "TRIO_ESIGNER_CKA_URL is required."
}

$parsedUrl = $null
# The caller must provide a pinned https:// archive URL and its lowercase digest.
if (-not [Uri]::TryCreate($CkaUrl, [UriKind]::Absolute, [ref]$parsedUrl) -or $parsedUrl.Scheme -ne "https") {
  Stop-Safely "TRIO_ESIGNER_CKA_URL must be an absolute HTTPS URL."
}

if ([string]::IsNullOrWhiteSpace($ExpectedSha256) -or $ExpectedSha256 -cnotmatch "^[a-f0-9]{64}$") {
  Stop-Safely "TRIO_ESIGNER_CKA_SHA256 must be lowercase SHA-256."
}

if ([string]::IsNullOrWhiteSpace($ExpectedPublisherSubject)) {
  Stop-Safely "TRIO_WINDOWS_PUBLISHER_SUBJECT is required."
}

$credentialPresent = @(
  $env:TRIO_ESIGNER_CKA_API_TOKEN,
  $env:TRIO_ESIGNER_CKA_CLIENT_SECRET,
  $env:TRIO_ESIGNER_CKA_CREDENTIAL
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
if ($credentialPresent.Count -eq 0) {
  Stop-Safely "An eSigner CKA credential must be provided through the protected environment."
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("trio-esigner-" + [Guid]::NewGuid().ToString("N"))
$archive = Join-Path $tempRoot "esigner-cka-installer.zip"
$extractRoot = Join-Path $tempRoot "extracted"
$createdTempRoot = $false

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $createdTempRoot = $true
  Invoke-WebRequest -Uri $CkaUrl -OutFile $archive -UseBasicParsing

  $actualSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -cne $ExpectedSha256) {
    Stop-Safely "The pinned eSigner CKA archive SHA-256 does not match."
  }

  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $extractRoot -Force
  $installerCandidates = @(
    Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Force |
      Where-Object {
        $_.Extension -ieq ".exe" -and
        (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
      }
  )
  if ($installerCandidates.Count -ne 1) {
    Stop-Safely "The pinned eSigner archive must contain exactly one regular installer executable."
  }
  $installerPath = [IO.Path]::GetFullPath($installerCandidates[0].FullName)
  $normalizedExtractRoot = [IO.Path]::GetFullPath($extractRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $installerPath.StartsWith($normalizedExtractRoot, [StringComparison]::OrdinalIgnoreCase)) {
    Stop-Safely "The selected eSigner installer is outside the extracted archive."
  }
  $installerResult = Start-Process -FilePath $installerPath -ArgumentList @("/quiet", "/norestart") -Wait -PassThru -WindowStyle Hidden
  if ($installerResult.ExitCode -ne 0) {
    Stop-Safely "The eSigner CKA installer failed."
  }

  $configurator = $env:TRIO_ESIGNER_CKA_CONFIGURATOR
  if ([string]::IsNullOrWhiteSpace($configurator)) {
    Stop-Safely "TRIO_ESIGNER_CKA_CONFIGURATOR is required."
  }
  if (-not (Test-Path -LiteralPath $configurator -PathType Leaf)) {
    Stop-Safely "The configured eSigner CKA configurator was not found."
  }

  # Credentials remain inherited protected environment values. They are never
  # placed in an argument list, a file, a PFX, or a workflow artifact.
  & $configurator --non-interactive *> $null
  if ($LASTEXITCODE -ne 0) {
    Stop-Safely "The eSigner CKA configurator failed."
  }

  $matchingCertificates = @(
    foreach ($store in @("Cert:\CurrentUser\My", "Cert:\LocalMachine\My")) {
      Get-ChildItem -Path $store -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq $ExpectedPublisherSubject }
    }
  )
  if ($matchingCertificates.Count -ne 1) {
    Stop-Safely "Exactly one expected publisher certificate must be present after eSigner setup."
  }
  if (-not $matchingCertificates[0].HasPrivateKey) {
    Stop-Safely "The expected publisher certificate has no private key."
  }

  Write-Output '{"configured":true}'
}
finally {
  if ($createdTempRoot -and (Test-Path -LiteralPath $tempRoot)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
