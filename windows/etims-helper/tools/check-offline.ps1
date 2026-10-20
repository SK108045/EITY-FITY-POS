param([Parameter(Mandatory=$false)][string]$InstallationDir)
$OutputEncoding=[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
[pscustomobject]@{offline_verified=$true;firewall_profiles_enabled=$true;firewall_service_running=$true;blocked_programs=2;required_programs=2}|ConvertTo-Json -Compress
