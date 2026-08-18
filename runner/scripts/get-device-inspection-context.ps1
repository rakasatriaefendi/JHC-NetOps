param(
  [Parameter(Mandatory = $true)]
  [string]$TargetIp
)

$ErrorActionPreference = "Stop"

function Convert-IPv4ToUInt32([string]$Address) {
  $bytes = ([System.Net.IPAddress]::Parse($Address)).GetAddressBytes()
  [Array]::Reverse($bytes)
  return [BitConverter]::ToUInt32($bytes, 0)
}

function Test-SameSubnet([string]$Left, [string]$Right, [int]$PrefixLength) {
  $mask = if ($PrefixLength -eq 0) { [uint32]0 } else { [uint32]::MaxValue -shl (32 - $PrefixLength) }
  return ((Convert-IPv4ToUInt32 $Left) -band $mask) -eq ((Convert-IPv4ToUInt32 $Right) -band $mask)
}

function Test-PrivateIPv4([string]$Address) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -or $parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  $parts = $Address.Split('.') | ForEach-Object { [int]$_ }
  return $parts[0] -eq 10 -or ($parts[0] -eq 172 -and $parts[1] -ge 16 -and $parts[1] -le 31) -or ($parts[0] -eq 192 -and $parts[1] -eq 168)
}

function Get-InterfaceType($Adapter) {
  $identity = "$($Adapter.Name) $($Adapter.InterfaceDescription)"
  if (-not [bool]$Adapter.HardwareInterface -or $identity -match "(?i)vethernet|hyper-v|wsl|virtual|vmware|virtualbox|loopback|tap") { return "virtual" }
  if ([bool]$Adapter.HardwareInterface) { return "physical" }
  return "unknown"
}

try {
  if (-not (Test-PrivateIPv4 $TargetIp)) { throw "Target is not a private IPv4 address" }
  # Find-NetRoute returns both an MSFT_NetIPAddress and an MSFT_NetRoute CIM
  # object. Select each object explicitly; reading InterfaceIndex from the
  # unfiltered array turns it into System.Object[] and breaks this helper.
  $routeItems = @(Find-NetRoute -RemoteIPAddress $TargetIp -ErrorAction Stop)
  $source = $routeItems |
    Where-Object { $_.CimClass.CimClassName -eq "MSFT_NetIPAddress" } |
    Select-Object -First 1
  $route = $routeItems |
    Where-Object { $_.CimClass.CimClassName -eq "MSFT_NetRoute" } |
    Select-Object -First 1
  if (-not $source -or -not $route) { throw "Windows route context is incomplete" }
  $localTarget = Get-NetIPAddress -AddressFamily IPv4 -IPAddress $TargetIp -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne "127.0.0.1" } |
    Select-Object -First 1
  if ($localTarget) { $source = $localTarget }
  $configuration = Get-NetIPConfiguration -InterfaceIndex $source.InterfaceIndex -ErrorAction Stop
  $adapter = Get-NetAdapter -InterfaceIndex $source.InterfaceIndex -ErrorAction Stop
  $gateway = $configuration.IPv4DefaultGateway.NextHop | Select-Object -First 1
  $sameSubnet = Test-SameSubnet ([string]$source.IPAddress) $TargetIp ([int]$source.PrefixLength)
  $routeRole = if ($gateway -and ([string]$gateway) -eq $TargetIp) { "default_gateway" } elseif ($sameSubnet) { "on_link" } else { "routed" }
  $mac = $null
  if ($sameSubnet -and -not $localTarget) {
    $neighbor = Get-NetNeighbor -AddressFamily IPv4 -InterfaceIndex $source.InterfaceIndex -IPAddress $TargetIp -ErrorAction SilentlyContinue |
      Where-Object { @("Reachable", "Stale", "Delay", "Probe", "Permanent") -contains ([string]$_.State) } |
      Select-Object -First 1
    if ($neighbor -and $neighbor.LinkLayerAddress -notmatch "^(00[:-]){5}00$") { $mac = [string]$neighbor.LinkLayerAddress }
  }
  $reachable = Test-Connection -ComputerName $TargetIp -Count 1 -Quiet -ErrorAction SilentlyContinue
  [ordered]@{
    ok = $true
    context = [ordered]@{
      target_ip = $TargetIp
      local_ip = [string]$source.IPAddress
      prefix_length = [int]$source.PrefixLength
      default_gateway = if ($gateway) { [string]$gateway } else { $null }
      same_subnet = [bool]$sameSubnet
      route_role = $routeRole
      mac = $mac
      reachable = [bool]$reachable
      is_this_device = [bool]$localTarget
      interface_index = [int]$source.InterfaceIndex
      interface_alias = [string]$adapter.Name
      interface_description = [string]$adapter.InterfaceDescription
      interface_type = Get-InterfaceType $adapter
    }
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  [ordered]@{ ok = $false; error_code = "INSPECTION_NETWORK_CONTEXT_UNAVAILABLE" } | ConvertTo-Json -Compress
  exit 2
}
