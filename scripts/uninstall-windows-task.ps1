[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$TaskName = 'Zero Task Node')

$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
    Write-Output ("Scheduled task '{0}' is not registered; nothing to remove." -f $TaskName)
    return
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister Zero scheduled task (runtime data and logs are retained)')) {
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -InputObject $task
        $deadline = (Get-Date).AddSeconds(30)
        do {
            Start-Sleep -Seconds 1
            $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $task.TaskPath -ErrorAction Stop
            if ($task.State -ne 'Running') { break }
        } while ((Get-Date) -lt $deadline)
        if ($task.State -eq 'Running') { throw "Task '$TaskName' did not stop within 30 seconds; it was not unregistered." }
    }
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
    Write-Output ("Removed scheduled task '{0}'. Runtime data and logs were retained." -f $TaskName)
}
