param(
    [Parameter(Mandatory=$true)][string]$LanIp,
    [string]$MosquittoDirectory = "C:\Program Files\mosquitto"
)
$ErrorActionPreference = "Stop"
$parsed = $null
if (-not [System.Net.IPAddress]::TryParse($LanIp, [ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) {
    throw "LanIp must be an IPv4 address assigned to this computer."
}
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -eq $LanIp })) {
    throw "This IPv4 address is not assigned to this computer. Run ipconfig and select the Wi-Fi IPv4 address."
}
if ($LanIp.StartsWith("127.") -or $LanIp -eq "0.0.0.0") { throw "Use your actual Wi-Fi/LAN IPv4 address." }
$broker = Join-Path $MosquittoDirectory "mosquitto.exe"
$passwordTool = Join-Path $MosquittoDirectory "mosquitto_passwd.exe"
if (-not (Test-Path $broker) -or -not (Test-Path $passwordTool)) { throw "Mosquitto tools not found; pass -MosquittoDirectory." }
$project = Split-Path $PSScriptRoot -Parent
$local = Join-Path $project ".local"
New-Item -ItemType Directory -Force -Path $local | Out-Null
$passwordFile = Join-Path $local "mosquitto-edge.passwd"
$configFile = Join-Path $local "mosquitto-edge.conf"
$aclFile = Join-Path $local "mosquitto-edge.acl"
if ((Test-Path $passwordFile) -or (Test-Path $configFile) -or (Test-Path $aclFile)) {
    throw "Edge broker files already exist in .local. Reuse them; edit listener IP there if the LAN address changed."
}
Write-Host "Create the MQTT password for solar_edge. Use the same password in ESP32 menuconfig."
& $passwordTool -c $passwordFile solar_edge
if ($LASTEXITCODE -ne 0) { throw "mosquitto_passwd failed." }
$acl = @"
user solar_edge
topic readwrite solar/home_01/telemetry
topic read solar/home_01/control
topic read solar/home_01/actuator
topic write solar/home_01/actuator/status
topic write solar/home_01/prediction
topic write solar/home_01/meter
"@
# Mosquitto accepts absolute paths with spaces as the remainder of a directive.
$configuration = @"
# Desktop programs stay on loopback port 1884.
per_listener_settings true
listener 1884 127.0.0.1
allow_anonymous true

# ESP32 uses an authenticated listener on this computer's LAN address.
listener 1885 $LanIp
allow_anonymous false
password_file $passwordFile
acl_file $aclFile
persistence false
"@
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($aclFile, $acl, $utf8)
[System.IO.File]::WriteAllText($configFile, $configuration, $utf8)
Write-Host "Ready. Stop the old broker on 1884, then run this command from the project root:"
Write-Host "& '$broker' -c '.\.local\mosquitto-edge.conf' -v"
Write-Host "ESP32 URI: mqtt://${LanIp}:1885 | username: solar_edge"
Write-Host "Desktop Python clients: 127.0.0.1:1884 (unchanged)."
