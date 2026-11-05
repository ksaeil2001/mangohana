param(
  [Parameter(Mandatory = $true)][int[]]$RootIds,
  [Parameter(Mandatory = $true)][string]$Output,
  [int]$MaxMinutes = 30
)
$ErrorActionPreference = 'Stop'
$resolvedOutput = [System.IO.Path]::GetFullPath($Output)
[System.IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null
$samplesPath = Join-Path $resolvedOutput 'process-samples.jsonl'
if (Test-Path -LiteralPath $samplesPath) { throw '기존 측정 파일은 덮어쓰지 않습니다.' }
$ownedIds = [System.Collections.Generic.HashSet[int]]::new()
foreach ($rootId in $RootIds) { [void]$ownedIds.Add($rootId) }
$deadline = (Get-Date).AddMinutes($MaxMinutes)
$sequence = 0
while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $resolvedOutput 'STOP'))) {
  $processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)
  do {
    $added = $false
    foreach ($item in $processes) {
      if ($ownedIds.Contains([int]$item.ParentProcessId) -and $ownedIds.Add([int]$item.ProcessId)) { $added = $true }
    }
  } while ($added)
  $rows = @()
  foreach ($item in $processes) {
    if (-not $ownedIds.Contains([int]$item.ProcessId)) { continue }
    try {
      $measured = Get-Process -Id $item.ProcessId -ErrorAction Stop
      $rows += [pscustomobject]@{
        pid = $item.ProcessId; parentPid = $item.ParentProcessId; name = $item.Name
        workingBytes = $measured.WorkingSet64; peakWorkingBytes = $measured.PeakWorkingSet64
        privateBytes = $measured.PrivateMemorySize64; cpuSeconds = $measured.CPU
      }
    } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
  }
  $record = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); processes = $rows }
  if ($sequence % 5 -eq 0) {
    $gpu = & 'C:\Windows\System32\nvidia-smi.exe' --query-gpu=index,memory.used,utilization.gpu --format=csv,noheader,nounits 2>$null
    $record.gpuDeviceWideCsv = @($gpu)
  }
  $record | ConvertTo-Json -Depth 6 -Compress | Add-Content -LiteralPath $samplesPath -Encoding utf8
  $sequence++
  Start-Sleep -Seconds 1
}
[ordered]@{ samples = $sequence; ownedPidsObserved = @($ownedIds); endedAt = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $resolvedOutput 'sampling-final.json') -Encoding utf8
