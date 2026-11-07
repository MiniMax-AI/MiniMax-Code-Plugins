# scripts/lib/Protect-Token.ps1
#
# DPAPI (Windows Data Protection API) helpers for the 5h usage token.
#
# The token used for the optional 5-hour usage readout is a credential, so
# it is never stored in the clear:
#
#   * set-token.ps1 encrypts it with Protect-Token and writes the base64
#     blob to config.json as `planApiTokenEnc`
#   * Resolve-PlanToken (in Get-5hUsage.ps1) decrypts it with Unprotect-Token
#
# The CurrentUser scope means only the same Windows user on the same
# machine can decrypt it. Copying config.json to another machine, or to
# another user, yields nothing usable.
#
# The functions are dot-source-only; there is no entry point.

function Test-TokenProtection {
  # Returns $true when DPAPI is usable in this PowerShell host.
  try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Protect-Token {
  # Encrypts $Plain with DPAPI (CurrentUser) and returns a base64 blob,
  # or $null when DPAPI is unavailable or encryption failed.
  param([string]$Plain)

  if (-not $Plain) { return $null }
  if (-not (Test-TokenProtection)) { return $null }
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Plain)
    $blob = [System.Security.Cryptography.ProtectedData]::Protect(
      $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Convert]::ToBase64String($blob)
  } catch {
    return $null
  }
}

function Unprotect-Token {
  # Decrypts a base64 blob produced by Protect-Token and returns the
  # plaintext, or $null when DPAPI is unavailable or the blob cannot be
  # decrypted (wrong user, different machine, corrupted).
  param([string]$Encoded)

  if (-not $Encoded) { return $null }
  if (-not (Test-TokenProtection)) { return $null }
  try {
    $blob = [Convert]::FromBase64String($Encoded)
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [System.Text.Encoding]::UTF8.GetString($bytes)
  } catch {
    return $null
  }
}

function Write-AtomicText {
  # Writes $Content to $Path through a staging file and a rename, so a
  # failure never truncates the file it replaces. config.json holds the
  # token, and a truncated config means the token is gone.
  #
  # The rename is retried because MoveFileEx with REPLACE_EXISTING fails
  # when the target is open by a reader that did not share delete.
  param(
    [string]$Path,
    [string]$Content
  )

  $tmp = "$Path.tmp"
  [System.IO.File]::WriteAllText($tmp, $Content, (New-Object System.Text.UTF8Encoding($false)))
  $attempt = 0
  while ($true) {
    try {
      Move-Item -Path $tmp -Destination $Path -Force
      break
    } catch {
      $attempt++
      if ($attempt -ge 20) { throw }
      Start-Sleep -Milliseconds 25
    }
  }
}
