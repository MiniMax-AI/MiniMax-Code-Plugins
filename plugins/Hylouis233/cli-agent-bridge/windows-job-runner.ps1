param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,
    [Parameter(Mandatory = $true)]
    [string]$NodeRunner
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CliAgentBridgeJobObject
{
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job, int informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    private static Win32Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    public static IntPtr CreateKillOnCloseJobForCurrentProcess()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw LastError("CreateJobObject");
        try
        {
            var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(
                    job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                    throw LastError("SetInformationJobObject");
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw LastError("AssignProcessToJobObject");
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }
}
'@

$jobHandle = [IntPtr]::Zero
try {
    # Containment must exist before stdin is read. The backend therefore cannot
    # start when Job creation, configuration, or nested assignment fails.
    $jobHandle = [CliAgentBridgeJobObject]::CreateKillOnCloseJobForCurrentProcess()
}
catch {
    [Console]::Error.WriteLine(
        "job-object initialization failed: " + $_.Exception.GetBaseException().Message)
    exit 125
}

try {
    # Node's spawn argument array preserves arbitrary task text exactly. Keep
    # the PowerShell layer responsible only for the Windows Job lifetime and
    # pipe the opaque JSON payload to the cross-platform runner.
    # Node writes JSON as UTF-8. Windows PowerShell 5.1 otherwise decodes stdin
    # with the console code page and encodes native-pipeline input as ASCII.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
    $payloadText = [Console]::In.ReadToEnd()
    $global:LASTEXITCODE = $null
    $payloadText | & $NodeExecutable $NodeRunner
    $succeeded = $?
    $nativeExitCode = $LASTEXITCODE
    if ($null -ne $nativeExitCode) {
        $runnerExitCode = [int]$nativeExitCode
    }
    elseif ($succeeded) {
        $runnerExitCode = 0
    }
    else {
        $runnerExitCode = 1
    }
}
catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    $runnerExitCode = 127
}

# The runner belongs to this Job. Keeping the last handle alive until process
# teardown makes Windows terminate every surviving descendant on normal exit,
# cancellation, timeout, or an abrupt parent-side kill.
[GC]::KeepAlive($jobHandle)
exit $runnerExitCode
