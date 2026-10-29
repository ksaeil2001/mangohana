[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageDirectory,
  [Parameter(Mandatory = $true)]
  [string]$AppExecutable,
  [Parameter(Mandatory = $true)]
  [string]$NsisInstaller,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [string]$ExpectedPublisherSubject = $env:TRIO_WINDOWS_PUBLISHER_SUBJECT
)

$ErrorActionPreference = "Stop"

function Stop-Safely([string]$Message) {
  throw $Message
}

if ([string]::IsNullOrWhiteSpace($ExpectedPublisherSubject)) {
  Stop-Safely "TRIO_WINDOWS_PUBLISHER_SUBJECT is required."
}

$signToolPath = $env:TRIO_SIGNTOOL_PATH
if ([string]::IsNullOrWhiteSpace($signToolPath)) {
  $signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($null -eq $signTool) {
    Stop-Safely "SignTool was not found on the Windows runner."
  }
  $signToolPath = $signTool.Source
}
if (-not (Test-Path -LiteralPath $signToolPath -PathType Leaf)) {
  Stop-Safely "The configured SignTool path was not found."
}

function Resolve-File([string]$Candidate) {
  $path = if ([IO.Path]::IsPathRooted($Candidate)) {
    [IO.Path]::GetFullPath($Candidate)
  } else {
    [IO.Path]::GetFullPath((Join-Path $PackageDirectory $Candidate))
  }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    Stop-Safely "A required signed release file was not found."
  }
  $attributes = [IO.File]::GetAttributes($path)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Stop-Safely "Signed release files must not be symbolic links or reparse points."
  }
  return $path
}

function Verify-SignedFile([string]$Path) {
  # Task 5B proves Authenticode properties here; Task 5A's
  # release-candidate-evidence.mjs computes and binds the exact file SHA-256
  # values in SHA256SUMS after these signed files are assembled. Keep those
  # evidence responsibilities separate so a signature check cannot stand in
  # for the candidate byte-digest check.
  $signToolOutput = & $signToolPath verify /pa /all /v $Path 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Stop-Safely "SignTool verification failed for a stable release file."
  }

  if ($signToolOutput -notmatch [Regex]::Escape($ExpectedPublisherSubject)) {
    Stop-Safely "The signed file publisher does not match the expected publisher."
  }
  if ($signToolOutput -notmatch "(?im)Digest Algorithm\s*:\s*SHA-?256") {
    Stop-Safely "The signed file does not use a SHA-256 digest."
  }
  if ($signToolOutput -notmatch "(?im)(?:TimeStamp|Timestamp)\s*:\s*\S+") {
    Stop-Safely "The signed file has no valid timestamp."
  }
}

$resolvedApp = Resolve-File $AppExecutable
$resolvedInstaller = Resolve-File $NsisInstaller
Verify-SignedFile $resolvedApp
Verify-SignedFile $resolvedInstaller

$sanitized = [ordered]@{
  expectedPublisherMatched = $true
  authenticodeChainValid = $true
  digestAlgorithm = "SHA-256"
  timestampValid = $true
  appExecutableVerified = $true
  nsisInstallerVerified = $true
}

$outputDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}
$sanitized | ConvertTo-Json -Compress | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
