param(
  [string]$ServerUrl = $env:PHONE_REMOTE_SERVER_URL
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
  $ServerUrl = "https://your-domain.example"
}
$ServerUrl = $ServerUrl.TrimEnd("/")
$MaxSearchResults = 100
$MaxSearchDirs = 2500
$MaxActiveDownloads = 2
$ExcludedSearchDirs = @(
  ".git", ".svn", ".hg", "node_modules", '$recycle.bin',
  "vendor", "dist", "build", "target", "logs", "log", "tmp", "temp",
  "cache", ".cache", ".trash", ".npm", ".yarn", ".pnpm", ".vscode",
  ".idea", ".gradle", ".m2", ".nuget", ".cargo", ".rustup", ".conda",
  "appdata", "library", "system volume information", "windows",
  "program files", "program files (x86)", "programdata"
)

$script:Session = $null
$script:DownloadJobs = New-Object System.Collections.Generic.List[object]

function ConvertTo-ForwardSlash([string]$PathValue) {
  return $PathValue.Replace("\", "/")
}

function Format-Size([Nullable[long]]$Bytes) {
  if ($null -eq $Bytes) { return "" }
  $units = @("B", "KB", "MB", "GB", "TB")
  [double]$value = $Bytes
  $index = 0
  while ($value -ge 1024 -and $index -lt $units.Count - 1) {
    $value = $value / 1024
    $index += 1
  }
  if ($value -ge 10 -or $index -eq 0) {
    return ("{0:N0} {1}" -f $value, $units[$index])
  }
  return ("{0:N1} {1}" -f $value, $units[$index])
}

function New-RootList {
  $userHome = [Environment]::GetFolderPath("UserProfile")
  $candidates = New-Object System.Collections.Generic.List[object]
  $candidates.Add([pscustomobject]@{ label = "User"; path = $userHome; kind = "home" })
  $candidates.Add([pscustomobject]@{ label = "Desktop"; path = [IO.Path]::Combine($userHome, "Desktop"); kind = "folder" })
  $candidates.Add([pscustomobject]@{ label = "Downloads"; path = [IO.Path]::Combine($userHome, "Downloads"); kind = "folder" })
  $candidates.Add([pscustomobject]@{ label = "Documents"; path = [IO.Path]::Combine($userHome, "Documents"); kind = "folder" })

  foreach ($drive in [IO.DriveInfo]::GetDrives()) {
    if ($drive.IsReady) {
      $driveLabel = "Drive " + $drive.Name.TrimEnd("\")
      $candidates.Add([pscustomobject]@{ label = $driveLabel; path = $drive.RootDirectory.FullName; kind = "drive" })
    }
  }

  $seen = @{}
  $roots = New-Object System.Collections.Generic.List[object]
  foreach ($item in $candidates) {
    if (-not (Test-Path -LiteralPath $item.path)) { continue }
    $full = [IO.Path]::GetFullPath($item.path)
    $key = $full.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $roots.Add([pscustomobject]@{
      id = "root-$($roots.Count)"
      label = $item.label
      kind = $item.kind
      path = $full
    })
  }
  return $roots.ToArray()
}

function Normalize-RelPath([string]$Value) {
  $raw = ""
  if ($null -ne $Value) { $raw = $Value }
  $raw = $raw.Replace("\", "/").TrimStart("/")
  if ([string]::IsNullOrWhiteSpace($raw)) { return "" }
  if (($raw -split "/") -contains "..") { throw "Invalid path." }
  if ([IO.Path]::IsPathRooted($raw)) { throw "Invalid path." }
  return [IO.Path]::GetFullPath([IO.Path]::Combine("C:\", $raw)).Substring(3)
}

function Resolve-AgentPath($RootId, [string]$RelPath) {
  $root = $script:Session.roots | Where-Object { $_.id -eq $RootId } | Select-Object -First 1
  if ($null -eq $root) { $root = $script:Session.roots[0] }
  if ($null -eq $root) { throw "No readable root was found." }

  $normalizedRel = Normalize-RelPath $RelPath
  $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root.path, $normalizedRel))
  $rootFull = [IO.Path]::GetFullPath($root.path)
  $rootPrefix = $rootFull
  if (-not $rootPrefix.EndsWith([IO.Path]::DirectorySeparatorChar)) {
    $rootPrefix = $rootPrefix + [IO.Path]::DirectorySeparatorChar
  }
  if ($target -ne $rootFull -and -not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside the selected root."
  }
  return [pscustomobject]@{ root = $root; relPath = $normalizedRel; target = $target }
}

function New-EntryPayload($Root, [string]$RelPath, [IO.FileSystemInfo]$Entry) {
  $isDir = ($Entry.Attributes -band [IO.FileAttributes]::Directory) -ne 0
  $entryRel = ConvertTo-ForwardSlash ([IO.Path]::Combine($RelPath, $Entry.Name))
  $size = $null
  if (-not $isDir -and $Entry -is [IO.FileInfo]) { $size = $Entry.Length }
  return [pscustomobject]@{
    name = $Entry.Name
    relPath = $entryRel
    rootId = $Root.id
    rootLabel = $Root.label
    isDir = $isDir
    type = $(if ($isDir) { "folder" } else { "file" })
    size = $size
    sizeLabel = $(if ($isDir) { "" } else { Format-Size $size })
    mtime = $Entry.LastWriteTimeUtc.ToString("o")
  }
}

function Invoke-AgentJson([string]$Route, $Payload, [int]$TimeoutSec = 35) {
  $json = $Payload | ConvertTo-Json -Depth 20 -Compress
  return Invoke-RestMethod -Uri "$ServerUrl$Route" -Method Post -ContentType "application/json; charset=utf-8" -Body $json -TimeoutSec $TimeoutSec
}

function Send-Result([string]$RequestId, $Result, [string]$ErrorMessage = "") {
  Invoke-AgentJson "/api/agent/result" @{
    agentId = $script:Session.agentId
    token = $script:Session.token
    requestId = $RequestId
    result = $Result
    error = $ErrorMessage
  } | Out-Null
}

function Invoke-ListCommand($Payload) {
  $resolved = Resolve-AgentPath $Payload.rootId $Payload.path
  $targetItem = Get-Item -LiteralPath $resolved.target -Force
  if (-not $targetItem.PSIsContainer) { throw "Target is not a folder." }

  $items = New-Object System.Collections.Generic.List[object]
  foreach ($entry in Get-ChildItem -LiteralPath $resolved.target -Force -ErrorAction SilentlyContinue) {
    try { $items.Add((New-EntryPayload $resolved.root $resolved.relPath $entry)) } catch {}
  }

  $sorted = @($items | Sort-Object @{ Expression = "isDir"; Descending = $true }, name)
  $parentPath = ""
  if ($resolved.relPath) {
    $parentDir = [IO.Path]::GetDirectoryName($resolved.relPath)
    if ($null -eq $parentDir) { $parentDir = "" }
    $parentPath = ConvertTo-ForwardSlash $parentDir
  }

  return [pscustomobject]@{
    root = $resolved.root
    path = ConvertTo-ForwardSlash $resolved.relPath
    parentPath = $parentPath
    items = $sorted
  }
}

function Invoke-SearchCommand($Payload) {
  $queryValue = ""
  if ($null -ne $Payload.q) { $queryValue = [string]$Payload.q }
  $query = $queryValue.Trim().ToLowerInvariant()
  if ($query.Length -lt 2) { throw "Search query must contain at least 2 characters." }

  $limitValue = 80
  if ($null -ne $Payload.limit) { $limitValue = [int]$Payload.limit }
  $limit = [Math]::Min($limitValue, $MaxSearchResults)
  $resolved = Resolve-AgentPath $Payload.rootId $Payload.path
  $results = New-Object System.Collections.Generic.List[object]
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue([pscustomobject]@{ abs = $resolved.target; rel = $resolved.relPath })
  $scannedDirs = 0
  $truncated = $false

  while ($queue.Count -gt 0 -and $results.Count -lt $limit) {
    if ($scannedDirs -ge $MaxSearchDirs) {
      $truncated = $true
      break
    }

    $current = $queue.Dequeue()
    $scannedDirs += 1
    $entries = @(Get-ChildItem -LiteralPath $current.abs -Force -ErrorAction SilentlyContinue)

    foreach ($entry in $entries) {
      $lowerName = $entry.Name.ToLowerInvariant()
      if ($lowerName.Contains($query)) {
        try {
          $results.Add((New-EntryPayload $resolved.root $current.rel $entry))
          if ($results.Count -ge $limit) { break }
        } catch {}
      }

      if ($entry.PSIsContainer -and -not $ExcludedSearchDirs.Contains($lowerName)) {
        $queue.Enqueue([pscustomobject]@{
          abs = $entry.FullName
          rel = [IO.Path]::Combine($current.rel, $entry.Name)
        })
      }
    }
  }

  return [pscustomobject]@{
    query = $query
    root = $resolved.root
    path = ConvertTo-ForwardSlash $resolved.relPath
    results = $results.ToArray()
    scannedDirs = $scannedDirs
    truncated = ($truncated -or $results.Count -ge $limit)
  }
}

function Clear-FinishedDownloadJobs {
  $remaining = New-Object System.Collections.Generic.List[object]
  foreach ($item in $script:DownloadJobs) {
    $job = $item.Job
    if ($job.State -eq "Running" -or $job.State -eq "NotStarted") {
      $remaining.Add($item)
      continue
    }

    try {
      Receive-Job -Job $job -ErrorAction SilentlyContinue | ForEach-Object {
        if ($null -ne $_) { Write-Host "[download] $_" }
      }
    } catch {}
    Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
  }
  $script:DownloadJobs = $remaining
}

function Invoke-DownloadCommand([string]$RequestId, $Payload) {
  Clear-FinishedDownloadJobs
  if ($script:DownloadJobs.Count -ge $MaxActiveDownloads) {
    throw "Too many downloads are running. Please wait for one to finish."
  }

  $resolved = Resolve-AgentPath $Payload.rootId $Payload.path
  $item = Get-Item -LiteralPath $resolved.target -Force
  if ($item.PSIsContainer) { throw "Only files can be downloaded." }

  $job = Start-Job -ArgumentList $ServerUrl, $script:Session.agentId, $script:Session.token, $RequestId, $item.FullName, $item.Name, $item.Length -ScriptBlock {
    param($ServerUrl, $AgentId, $Token, $RequestId, $FilePath, $FileName, $FileSize)

    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"

    try {
      $headers = @{
        "x-agent-id" = $AgentId
        "x-agent-token" = $Token
        "x-file-name" = [uri]::EscapeDataString($FileName)
        "x-file-size" = [string]$FileSize
      }
      Invoke-WebRequest -Uri "$ServerUrl/api/agent/upload?requestId=$RequestId" -Method Post -Headers $headers -ContentType "application/octet-stream" -InFile $FilePath -TimeoutSec 1800 | Out-Null
      "Finished: $FileName"
    } catch {
      $message = $_.Exception.Message
      try {
        $payload = @{
          agentId = $AgentId
          token = $Token
          requestId = $RequestId
          result = $null
          error = $message
        } | ConvertTo-Json -Depth 20 -Compress
        Invoke-RestMethod -Uri "$ServerUrl/api/agent/result" -Method Post -ContentType "application/json; charset=utf-8" -Body $payload -TimeoutSec 30 | Out-Null
      } catch {}
      throw
    }
  }

  $script:DownloadJobs.Add([pscustomobject]@{
    RequestId = $RequestId
    FileName = $item.Name
    Job = $job
  })
  Write-Host "[download] Started in background: $($item.Name)"
}

function Invoke-AgentCommand($Command) {
  if ($null -eq $Command -or [string]::IsNullOrWhiteSpace($Command.id)) { return }
  try {
    if ($Command.type -eq "list") {
      Send-Result $Command.id (Invoke-ListCommand $Command.payload)
      return
    }
    if ($Command.type -eq "search") {
      Send-Result $Command.id (Invoke-SearchCommand $Command.payload)
      return
    }
    if ($Command.type -eq "download") {
      Invoke-DownloadCommand $Command.id $Command.payload
      return
    }
    throw "Unknown command: $($Command.type)"
  } catch {
    try {
      Send-Result $Command.id $null $_.Exception.Message
    } catch {
      # Ignore error reporting failure (e.g. download was already aborted/cleaned up)
    }
  }
}

$roots = New-RootList
if ($roots.Count -eq 0) { throw "No readable root was found." }

while ($true) {
  try {
    $connect = Invoke-AgentJson "/api/agent/connect" @{
      host = $env:COMPUTERNAME
      platform = "win32"
      roots = $roots
      version = "1.0.0-powershell"
    }

    $script:Session = [pscustomobject]@{
      agentId = $connect.agentId
      token = $connect.token
      pairingPin = $connect.pairingPin
      roots = $roots
    }

    Write-Host "========================================"
    Write-Host "  PC agent connected to server"
    Write-Host "  Server: $ServerUrl"
    Write-Host "  Host:   $env:COMPUTERNAME"
    Write-Host "  PIN:    $($connect.pairingPin)"
    Write-Host "  Open the phone website and enter this PIN."
    Write-Host "  Keep this window running. Press Ctrl+C to stop."
    Write-Host "========================================"

    $delay = 1
    while ($true) {
      try {
        $poll = Invoke-AgentJson "/api/agent/poll" @{
          agentId = $script:Session.agentId
          token = $script:Session.token
        } 40
        $delay = 1
        if ($poll.command) {
          Invoke-AgentCommand $poll.command
        }
        Clear-FinishedDownloadJobs
      } catch {
        $statusCode = 0
        if ($null -ne $_.Exception.Response) {
          $statusCode = [int]$_.Exception.Response.StatusCode
        }
        Write-Host "[agent] $($_.Exception.Message)"
        if ($statusCode -eq 401) {
          Write-Host "Session expired on server. Re-registering to get new PIN..."
          break
        }
        Start-Sleep -Seconds $delay
        $delay = [Math]::Min([int]($delay * 1.5 + 1), 10)
      }
    }
  } catch {
    Write-Host "Connection error: $($_.Exception.Message)"
    Start-Sleep -Seconds 5
  }
}
