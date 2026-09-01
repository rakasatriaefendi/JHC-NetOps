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

function Get-InterfaceKind($Adapter) {
  $identity = "$($Adapter.Name) $($Adapter.InterfaceDescription)"
  if ($identity -match "(?i)docker|container|wsl|default\s+switch|host[- ]only|internal\s+switch") { return "virtual_internal" }
  if ($identity -match "(?i)vpn|tunnel|wireguard|openvpn|tailscale|\btap\b|\btun\b") { return "tunnel" }
  if ([bool]$Adapter.Virtual -or -not [bool]$Adapter.HardwareInterface) { return "virtual" }
  return "physical"
}

function Get-OperationalStatus($Adapter) {
  if (([string]$Adapter.Status).ToLowerInvariant() -eq "up") { return "up" }
  if (([string]$Adapter.Status).ToLowerInvariant() -in @("down", "disconnected", "disabled")) { return "down" }
  return "unknown"
}

try {
  $routeItems = @(Get-DefaultPhysicalRoute)
  $source = $routeItems[0]
  $route = $routeItems[1]
  $adapter = Get-NetAdapter -InterfaceIndex $source.InterfaceIndex -ErrorAction Stop
  if (([string]$adapter.Status).ToLowerInvariant() -ne "up") { throw "Interface is not up" }
  $configuration = Get-NetIPConfiguration -InterfaceIndex $source.InterfaceIndex -ErrorAction Stop
  $prefix = [int]$source.PrefixLength
  $gateway = $configuration.IPv4DefaultGateway.NextHop | Select-Object -First 1
  $allowedStates = @("Reachable", "Stale", "Delay", "Probe", "Permanent")
  $neighbors = @(Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex $source.InterfaceIndex -ErrorAction SilentlyContinue |
    Where-Object {
      $allowedStates -contains ([string]$_.State) -and
      $_.IPAddress -ne "0.0.0.0" -and
      $_.IPAddress -ne "255.255.255.255" -and
      [int]($_.IPAddress.Split('.')[0]) -lt 224
    } |
    Select-Object IPAddress, State |
    ForEach-Object {
      @{ ip = $_.IPAddress; state = [string]$_.State }
    } | Sort-Object ip -Unique)

  $scopeInterfaces = @(Get-NetAdapter -IncludeHidden -ErrorAction SilentlyContinue |
    Select-Object -First 64 |
    ForEach-Object {
      $scopeAdapter = $_
      [object[]]$addresses = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $scopeAdapter.InterfaceIndex -ErrorAction SilentlyContinue |
        Select-Object -First 16 |
        ForEach-Object {
          [pscustomobject][ordered]@{
            ip_address = [string]$_.IPAddress
            prefix_length = [int]$_.PrefixLength
          }
        })
      [ordered]@{
        interface_index = [int]$scopeAdapter.InterfaceIndex
        interface_alias = [string]$scopeAdapter.Name
        operational_status = Get-OperationalStatus $scopeAdapter
        interface_kind = Get-InterfaceKind $scopeAdapter
        connection_type = Get-ConnectionType $scopeAdapter
        addresses = $addresses
      }
    })

  $scopeRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.State -ne "Invalid" } |
    Sort-Object DestinationPrefix, RouteMetric, InterfaceMetric |
    Select-Object -First 256 |
    ForEach-Object {
      [ordered]@{
        destination_cidr = [string]$_.DestinationPrefix
        interface_index = [int]$_.InterfaceIndex
      }
    })

  [ordered]@{
    ok = $true
    context = [ordered]@{
      connection_type = Get-ConnectionType $adapter
      interface_alias = [string]$adapter.Name
      local_ipv4 = [string]$source.IPAddress
      subnet_cidr = Get-SubnetCidr ([string]$source.IPAddress) $prefix
      prefix_length = $prefix
      default_gateway = if ($gateway) { [string]$gateway } else { $null }
      neighbors = $neighbors
      scope_inputs = [ordered]@{
        default_interface_index = [int]$source.InterfaceIndex
        interfaces = $scopeInterfaces
        routes = $scopeRoutes
      }
    }
  } | ConvertTo-Json -Depth 8 -Compress
} catch {
  [ordered]@{ ok = $false; error_code = "DISCOVERY_CONTEXT_UNAVAILABLE" } | ConvertTo-Json -Compress
  exit 2
}
