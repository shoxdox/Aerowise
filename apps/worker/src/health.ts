import { checkHeartbeat, heartbeatFromEnv } from "@aerowise/tasks";

// Health check for hosts that run a command (Docker HEALTHCHECK, Compose): exits 0 when the
// worker on this machine finished a pass of its loop recently, 1 otherwise.
const status = await checkHeartbeat(heartbeatFromEnv(process.env));
if (status.ok) {
  console.log(`worker ok (last pass ${Math.round(status.ageMs / 1000)}s ago)`);
} else {
  console.error(`worker unhealthy: ${status.reason}`);
  process.exit(1);
}
