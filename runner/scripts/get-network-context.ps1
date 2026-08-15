param(
  [Parameter(Mandatory = $true)]
  [ValidateLength(1, 253)]
  [string]$TargetHost,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 65535)]
  [int]$TargetPort
)

$ErrorActionPreference = "Stop"

function Convert-PrefixToMask([int]$PrefixLength) {
  $octets = for ($index = 0; $index -lt 4; $index++) {
    $remaining = [Math]::Max(0, [Math]::Min(8, $PrefixLength - ($index * 8)))
    if ($remaining -eq 0) { 0 } else { 256 - [Math]::Pow(2, 8 - $remaining) }
  }
  return ($octets -join ".")
}

function Get-SubnetCidr([string]$Address, [int]$PrefixLength) {
  $addressBytes = ([System.Net.IPAddress]::Parse($Address)).GetAddressBytes()
  $maskBytes = ([System.Net.IPAddress]::Parse((Convert-PrefixToMask $PrefixLength))).GetAddressBytes()
  $networkBytes = for ($index = 0; $index -lt 4; $index++) {
    $addressBytes[$index] -band $maskBytes[$index]
  }
  return "$([System.Net.IPAddress]::new([byte[]]$networkBytes))/$PrefixLength"
}

function Get-PingObservation([string]$Address) {
  $reply = Test-Connection -ComputerName $Address -Count 1 -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $reply) {
    return [ordered]@{ status = "no_response"; latency_ms = $null }
  }
  return [ordered]@{ status = "responded"; latency_ms = [double]$reply.ResponseTime }
}

function Test-TcpReadiness([string]$Address, [int]$Port) {
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $pending = $client.BeginConnect($Address, $Port, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(2500, $false)) { return $false }
    $client.EndConnect($pending)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-DefaultPhysicalRoute {
  $routes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop |
    Where-Object { $_.State -ne "Invalid" } |
    Sort-Object @{ Expression = { [int]$_.RouteMetric + [int]$_.InterfaceMetric } }
  foreach ($route in $routes) {
    $address = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" } |
      Select-Object -First 1
    if ($address) { return @($address, $route) }
  }
  throw "No physical IPv4 default route"
}

function Get-ConnectionType($Adapter) {
  $identity = "$($Adapter.Name) $($Adapter.InterfaceDescription) $($Adapter.MediaType) $($Adapter.PhysicalMediaType)"
  if ($identity -match "(?i)wi-?fi|wireless|802\.11") { return "wifi" }
  if ($Adapter.MediaType -eq "802.3" -or $Adapter.PhysicalMediaType -eq "802.3") { return "ethernet" }
  return "unknown"
}

function Get-WifiContext([string]$InterfaceAlias) {
  $result = [ordered]@{}
  try {
    $lines = & netsh.exe wlan show interfaces 2>$null
    $currentName = $null
    foreach ($line in $lines) {
      if ($line -match '^\s*Name\s*:\s*(.+)$') { $currentName = $Matches[1].Trim(); continue }
      if ($currentName -ne $InterfaceAlias) { continue }
      if ($line -match '^\s*SSID\s*:\s*(.+)$') { $result.ssid = $Matches[1].Trim(); continue }
      if ($line -match '^\s*Signal\s*:\s*(\d+)%') { $result.signal_percent = [int]$Matches[1]; continue }
      if ($line -match '^\s*Receive rate \(Mbps\)\s*:\s*([\d.]+)') { $result.receive_rate_mbps = [double]$Matches[1]; continue }
      if ($line -match '^\s*Transmit rate \(Mbps\)\s*:\s*([\d.]+)') { $result.transmit_rate_mbps = [double]$Matches[1] }
    }
  } catch {}
  return $result
}

try {
  $resolved = [System.Net.Dns]::GetHostAddresses($TargetHost) |
    Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
    Select-Object -First 1
  if ($null -eq $resolved) { throw "No IPv4 target address" }
  $targetIp = $resolved.IPAddressToString

  $targetRouteItems = @(Find-NetRoute -RemoteIPAddress $targetIp -ErrorAction Stop)
  $targetSource = $targetRouteItems | Where-Object { $_.CimClass.CimClassName -eq "MSFT_NetIPAddress" } | Select-Object -First 1
  $targetRoute = $targetRouteItems | Where-Object { $_.CimClass.CimClassName -eq "MSFT_NetRoute" } | Select-Object -First 1
  if ($null -eq $targetSource -or $null -eq $targetRoute) { throw "No route to target" }

  $isLoopback = $targetIp.StartsWith("127.")
  if ($isLoopback) {
    $physicalRouteItems = @(Get-DefaultPhysicalRoute)
    $physicalSource = $physicalRouteItems[0]
    $physicalRoute = $physicalRouteItems[1]
  } else {
    $physicalSource = $targetSource
    $physicalRoute = $targetRoute
  }

  $adapter = Get-NetAdapter -InterfaceIndex $physicalSource.InterfaceIndex -ErrorAction Stop
  $ipConfiguration = Get-NetIPConfiguration -InterfaceIndex $physicalSource.InterfaceIndex -ErrorAction Stop
  $connectionType = Get-ConnectionType $adapter
  $prefixLength = [int]$physicalSource.PrefixLength
  $defaultGateway = $ipConfiguration.IPv4DefaultGateway.NextHop | Select-Object -First 1
  $dnsServers = @($ipConfiguration.DNSServer.ServerAddresses | Where-Object { $_ -and $_.Length -le 64 } | Select-Object -First 6)
  $nextHop = if ($targetRoute.NextHop -and $targetRoute.NextHop -ne "0.0.0.0") { [string]$targetRoute.NextHop } else { $null }
  $routeType = if ($null -eq $nextHop) { "on_link" } else { "routed" }

  $networkContext = [ordered]@{
    host_name = [Environment]::MachineName
    interface_alias = [string]$adapter.Name
    interface_description = [string]$adapter.InterfaceDescription
    connection_type = $connectionType
    operational_status = ([string]$adapter.Status).ToLowerInvariant()
    local_ipv4 = [string]$physicalSource.IPAddress
    prefix_length = $prefixLength
    subnet_mask = Convert-PrefixToMask $prefixLength
    subnet_cidr = Get-SubnetCidr ([string]$physicalSource.IPAddress) $prefixLength
    default_gateway = if ($defaultGateway) { [string]$defaultGateway } else { $null }
    dns_servers = $dnsServers
    link_speed_mbps = if ($adapter.ReceiveLinkSpeed -gt 0) { [Math]::Round(([double]$adapter.ReceiveLinkSpeed / 1000000), 2) } else { $null }
  }
  if ($connectionType -eq "wifi") {
    $wifi = Get-WifiContext ([string]$adapter.Name)
    if ($wifi.ssid) { $networkContext.ssid = $wifi.ssid }
    if ($null -ne $wifi.signal_percent) { $networkContext.wifi_signal_percent = $wifi.signal_percent }
    if ($null -ne $wifi.receive_rate_mbps) { $networkContext.wifi_receive_rate_mbps = $wifi.receive_rate_mbps }
    if ($null -ne $wifi.transmit_rate_mbps) { $networkContext.wifi_transmit_rate_mbps = $wifi.transmit_rate_mbps }
  }

  $routeContext = [ordered]@{
    target_host = $TargetHost
    resolved_target_ip = $targetIp
    route_type = $routeType
    source_ip = [string]$targetSource.IPAddress
    interface_alias = [string]$targetSource.InterfaceAlias
    interface_index = [int]$targetSource.InterfaceIndex
    next_hop = $nextHop
    route_metric = [int]$targetRoute.RouteMetric + [int]$targetRoute.InterfaceMetric
  }

  $preflight = [ordered]@{
    checked_at = [DateTime]::UtcNow.ToString("o")
    interface_detected = $true
    route_resolved = $true
    gateway = if ($nextHop) { Get-PingObservation $nextHop } else { $null }
    target = Get-PingObservation $targetIp
    iperf = [ordered]@{
      ready = Test-TcpReadiness $targetIp $TargetPort
      port = $TargetPort
    }
  }

  [ordered]@{
    ok = $true
    network_context = $networkContext
    route_context = $routeContext
    preflight = $preflight
  } | ConvertTo-Json -Depth 7 -Compress
} catch {
  [ordered]@{ ok = $false; error_code = "NETWORK_CONTEXT_UNAVAILABLE" } | ConvertTo-Json -Compress
  exit 2
}
