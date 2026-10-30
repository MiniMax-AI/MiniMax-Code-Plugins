# Status-Store.ps1 -- the cross-process protocol for status.json.
#
# Two independent processes write this file:
#
#   - the detector daemon (mcode-status-detect.ps1), which restates the
#     current state every 60s and asserts a new state whenever it infers
#     one from the session log;
#   - the agent hooks, through notify-island.ps1, which runs as a child
#     process for every tool call.
#
# They used to have no mutual exclusion at all. The detector read
# status.json, the hook wrote it, and the detector then overwrote the
# hook's write with a payload built from the older read -- so the hook's
# step/total/detail were either mixed into a stale payload or lost
# outright. Both writers also staged through the same "status.json.tmp"
# path, so one could rename the other's half-written file into place.
#
# This file is the one place where that protocol lives:
#
#   Enter-StatusLock / Exit-StatusLock
#       An exclusive cross-process lock on a sibling lock file. It is a
#       real OS file lock (FileShare.None), not a flag file whose
#       presence we poll: a flag file has the same check-then-act hole
#       the payload has. If a holder dies, the OS releases the handle.
#
#   Read-StatusSnapshot
#       One read of the whole status object. Callers read once and reuse
#       that snapshot. Reading again after another writer had a chance to
#       run is what produced the mixed-generation payloads.
#
#   Write-StatusSnapshot
#       Atomic replace (staging file + rename) that also stamps the
#       monotonic `version` counter and the `ts` timestamp.
#
# ASCII only on purpose. Windows PowerShell 5.1 decodes a BOM-less
# script with the system ANSI codepage, and this file is dot-sourced by
# the detector, which runs under 5.1 on a zh-CN host (round-20 #4).

function Get-StatusStoreDir {
  return (Join-Path $env:APPDATA 'mcode-island')
}

function Get-StatusFilePath {
  return (Join-Path (Get-StatusStoreDir) 'status.json')
}

function Get-StatusLockPath {
  return (Join-Path (Get-StatusStoreDir) 'status.lock')
}

# Takes the exclusive cross-process lock and returns the open handle.
# The caller MUST pass it to Exit-StatusLock, ideally in a finally.
#
# Not re-entrant by design: a nested take would deadlock against
# itself, because the OS refuses a second open of a FileShare.None file
# even from the same process. Code that needs to write while already
# holding the lock calls the *UnderLock helper instead of taking it
# twice.
function Enter-StatusLock {
  param(
    [int]$TimeoutMs = 3000,
    [int]$RetryMs = 15
  )
  $dir = Get-StatusStoreDir
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $lockPath = Get-StatusLockPath
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ($true) {
    try {
      # FileShare.None: the OS refuses any other open of this file until
      # this handle is closed. That is the mutual exclusion we need,
      # across processes that know nothing about each other.
      return [System.IO.File]::Open(
        $lockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None)
    } catch {
      if ((Get-Date) -ge $deadline) {
        throw "status.json lock timeout after $TimeoutMs ms: $lockPath"
      }
      Start-Sleep -Milliseconds $RetryMs
    }
  }
}

function Exit-StatusLock {
  param($Handle)
  if ($null -eq $Handle) { return }
  try { $Handle.Dispose() } catch { }
}

function Read-StatusSnapshot {
  $file = Get-StatusFilePath
  if (!(Test-Path $file)) { return $null }
  try {
    return ([System.IO.File]::ReadAllText($file) | ConvertFrom-Json)
  } catch {
    return $null
  }
}

# Replaces status.json with $Payload.
#
# $Previous is the snapshot the payload was built from. It is used for
# the version counter, so that the counter advances exactly once per
# write and two writers can never mint the same version. Pass the same
# snapshot the payload was derived from -- not a fresh read -- otherwise
# the counter is derived from a generation that may already be stale.
#
# The caller must hold the lock.
function Write-StatusSnapshot {
  param(
    [Parameter(Mandatory = $true)]$Payload,
    $Previous = $null
  )
  $dir = Get-StatusStoreDir
  if (!(Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $file = Get-StatusFilePath

  if ($null -eq $Previous) { $Previous = Read-StatusSnapshot }

  $version = 1
  if ($null -ne $Previous -and $Previous.PSObject.Properties['version']) {
    $version = ([int]$Previous.version) + 1
  }

  $ordered = [ordered]@{}
  if ($Payload -is [System.Collections.IDictionary]) {
    foreach ($k in $Payload.Keys) { $ordered[$k] = $Payload[$k] }
  } else {
    foreach ($p in $Payload.PSObject.Properties) { $ordered[$p.Name] = $p.Value }
  }
  $ordered['ts'] = (Get-Date).ToString('o')
  $ordered['version'] = $version

  $json = [PSCustomObject]$ordered | ConvertTo-Json -Compress

  # Staging file + rename. The staging name is fixed rather than
  # per-PID: every writer holds the lock, so only one staging file is
  # ever live, and a writer that dies between the two steps leaves a
  # file the next writer overwrites instead of a pile of orphans.
  $tmp = "$file.tmp"
  [System.IO.File]::WriteAllText($tmp, $json, [System.Text.Encoding]::UTF8)

  # The replace is retried because it can lose a sharing violation.
  #
  # MoveFileEx with REPLACE_EXISTING fails when the target is open by a
  # reader that did not share delete. The widget polls status.json
  # every 400 ms with Get-Content, and Get-Content opens with
  # FileShare.Read -- no delete. So a write that lands while the widget
  # happens to hold the file open throws "the file already exists" and
  # the update is lost: the staging file survives, the target keeps the
  # old payload, and the caller sees an exception.
  #
  # The reader holds the file for microseconds, so one short retry
  # clears it. The staging file is untouched by a failed move, so the
  # retry re-moves the same bytes.
  $attempt = 0
  while ($true) {
    try {
      Move-Item -Path $tmp -Destination $file -Force
      break
    } catch {
      $attempt++
      if ($attempt -ge 20) { throw }
      Start-Sleep -Milliseconds 25
    }
  }
  # No return value on purpose. The detector calls this from inside its
  # main loop, and a returned version would be echoed to the daemon's
  # stdout on every write. The version is in the file; a caller that
  # needs it reads it from there.
}
