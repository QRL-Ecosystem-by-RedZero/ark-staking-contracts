<#
.SYNOPSIS
  Enables the Windows virtualization features Docker Desktop needs, so that a
  Kurtosis private QRL Zond network can run on this machine.

.DESCRIPTION
  Docker Desktop reports "Virtualization support not detected" on this machine.
  That message is misleading. The CPU (i7-12700K) supports VT-x, and a
  hypervisor is already running for Virtualization-Based Security -- which is
  precisely why Win32_Processor.VMMonitorModeExtensions reads False, the bit
  Docker Desktop inspects. VBS owns the hypervisor, so the host cannot see the
  raw VT-x bits.

  The real blocker is that every virtualization Windows feature is disabled:
  VirtualMachinePlatform, Microsoft-Windows-Subsystem-Linux, HypervisorPlatform
  and Microsoft-Hyper-V-All. Docker Desktop has no backend to start on.

  This script enables the two features the WSL2 backend needs, then installs
  WSL. A REBOOT IS REQUIRED before the changes take effect.

.NOTES
  MUST be run from an elevated PowerShell (Run as Administrator).
  Every change here is reversible -- see the "Rolling back" section at the end
  of the output.
#>

[CmdletBinding()]
param(
    # Also enable the full Hyper-V role. Not needed for the WSL2 backend, and it
    # can conflict with VMware/VirtualBox, so it is off by default.
    [switch]$IncludeHyperV,

    # Install a distro too. Without this, WSL is installed with no distribution,
    # which is enough for Docker Desktop's WSL2 backend but not enough to run
    # the Kurtosis CLI, which needs a Linux userland.
    [string]$Distro = 'Ubuntu'
)

$ErrorActionPreference = 'Stop'

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Elevated)) {
    Write-Host ''
    Write-Host 'This script must run elevated.' -ForegroundColor Red
    Write-Host 'Open PowerShell with "Run as Administrator", then run:' -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '=== Current state ===' -ForegroundColor Cyan
$features = @(
    'VirtualMachinePlatform',
    'Microsoft-Windows-Subsystem-Linux',
    'HypervisorPlatform',
    'Microsoft-Hyper-V-All'
)
Get-CimInstance Win32_OptionalFeature |
    Where-Object { $features -contains $_.Name } |
    Select-Object Name, @{n = 'State'; e = { if ($_.InstallState -eq 1) { 'Enabled' } else { 'Disabled' } } } |
    Sort-Object Name | Format-Table -AutoSize

$targets = @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')
if ($IncludeHyperV) { $targets += 'Microsoft-Hyper-V-All' }

Write-Host '=== Enabling features ===' -ForegroundColor Cyan
foreach ($f in $targets) {
    Write-Host "  $f ..." -NoNewline
    # /norestart so all features are staged before a single reboot at the end.
    $null = dism.exe /online /enable-feature /featurename:$f /all /norestart
    if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 3010) {
        Write-Host ' ok' -ForegroundColor Green
    } else {
        Write-Host " FAILED (dism exit $LASTEXITCODE)" -ForegroundColor Red
        exit 1
    }
}

Write-Host ''
Write-Host '=== Installing WSL ===' -ForegroundColor Cyan
# The features above are not active until reboot, so WSL cannot finish
# provisioning a distro yet. Stage the WSL runtime now and install the distro
# after the restart.
wsl.exe --install --no-distribution 2>&1 | Out-String | Write-Host

Write-Host ''
Write-Host '=== Next steps ===' -ForegroundColor Cyan
Write-Host '  1. REBOOT this machine.' -ForegroundColor Yellow
Write-Host '  2. After the reboot, in a normal (non-elevated) terminal:'
Write-Host "       wsl --set-default-version 2"
Write-Host "       wsl --install -d $Distro"
Write-Host '     ...then set a UNIX username and password when prompted.'
Write-Host '  3. Start Docker Desktop. In Settings > General, confirm'
Write-Host '     "Use the WSL 2 based engine" is ticked, and under'
Write-Host '     Settings > Resources > WSL integration, enable it for the distro.'
Write-Host '  4. Verify:  docker run --rm hello-world'
Write-Host '  5. Then run scripts/kurtosis-up.sh from inside WSL.'
Write-Host ''
Write-Host '=== Rolling back ===' -ForegroundColor Cyan
Write-Host '  To undo everything this script did, elevated:'
foreach ($f in $targets) {
    Write-Host "     dism /online /disable-feature /featurename:$f /norestart"
}
Write-Host '  ...then reboot.'
Write-Host ''
