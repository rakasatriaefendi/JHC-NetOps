export function startHeartbeatLoop(sendHeartbeat, intervalMs, onError = () => {}) {
  let inFlight = false;
  const timer = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await sendHeartbeat();
    } catch (error) {
      onError(error);
    } finally {
      inFlight = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
