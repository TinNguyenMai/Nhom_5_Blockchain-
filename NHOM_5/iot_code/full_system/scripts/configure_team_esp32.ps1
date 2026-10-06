param(
    [Parameter(Mandatory=$true)][string]$LanIp,
    [string]$WifiSsid,
    [string]$MqttUsername = "solar_edge"
)
$ErrorActionPreference = "Stop"
$taskIp = $null
if (-not [System.Net.IPAddress]::TryParse($LanIp, [ref]$taskIp) -or
    $taskIp.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    $LanIp.StartsWith("127.") -or $LanIp -eq "0.0.0.0") {
    throw "LanIp must be the broker computer's actual LAN IPv4 address."
}
if (-not $WifiSsid) { $WifiSsid = Read-Host "Wi-Fi SSID (2.4 GHz)" }
if (-not $WifiSsid) { throw "Wi-Fi SSID is required." }
function Read-SecretText([string]$Prompt) {
    $taskSecure = Read-Host $Prompt -AsSecureString
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
}
function Escape-Config([string]$Value) {
    if ($Value -match "[\r\n]") { throw "Configuration values cannot contain a newline." }
    return $Value.Replace('\', '\\').Replace('"', '\"')
}
$taskWifiPassword = Read-SecretText "Wi-Fi password"
$taskMqttPassword = Read-SecretText "MQTT password (same password created by setup_edge_broker.ps1)"
if (-not $taskMqttPassword) { throw "The authenticated LAN broker requires a password." }
$taskRoot = Split-Path $PSScriptRoot -Parent
$taskFirmware = Join-Path $taskRoot "iot_code/firmware/esp32_edge"
$taskTemplate = Join-Path $taskFirmware "sdkconfig.team.example"
if (-not (Test-Path -LiteralPath $taskTemplate)) { throw "Run this script from the p2p-solar-team package." }
$taskText = Get-Content -Raw -LiteralPath $taskTemplate
$taskValues = @{
    SOLAR_WIFI_SSID = $WifiSsid
    SOLAR_WIFI_PASSWORD = $taskWifiPassword
    SOLAR_MQTT_URI = "mqtt://${LanIp}:1885"
    SOLAR_MQTT_USERNAME = $MqttUsername
    SOLAR_MQTT_PASSWORD = $taskMqttPassword
}
foreach ($taskEntry in $taskValues.GetEnumerator()) {
    $taskPattern = '(?m)^CONFIG_' + $taskEntry.Key + '=.*$'
    if (-not [regex]::IsMatch($taskText, $taskPattern)) { throw "Missing configuration field: $($taskEntry.Key)" }
    $taskLine = 'CONFIG_' + $taskEntry.Key + '="' + (Escape-Config $taskEntry.Value) + '"'
    $taskText = [regex]::Replace($taskText, $taskPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $taskLine })
}
$taskEncoding = New-Object System.Text.UTF8Encoding($false)
foreach ($taskName in @('sdkconfig.esp32dev_ai', 'sdkconfig')) {
    [System.IO.File]::WriteAllText((Join-Path $taskFirmware $taskName), $taskText, $taskEncoding)
}
$taskWifiPassword = $taskMqttPassword = $null
Write-Host "Firmware network configuration saved locally. Passwords were not printed."
Write-Host "Next: open iot_code/firmware/esp32_edge in PlatformIO and Build/Upload esp32dev_ai."
