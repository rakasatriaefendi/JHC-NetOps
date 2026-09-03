const SUPPORTED_PLATFORMS = new Set(["win32", "linux"]);

export function resolvePlatform(value = process.platform) {
  if (!SUPPORTED_PLATFORMS.has(value)) {
    const error = new Error(`Unsupported runner platform: ${String(value)}`);
    error.code = "UNSUPPORTED_PLATFORM";
    throw error;
  }
  return value;
}

export function isWindowsPlatform(value = process.platform) {
  return resolvePlatform(value) === "win32";
}

export function isLinuxPlatform(value = process.platform) {
  return resolvePlatform(value) === "linux";
}
