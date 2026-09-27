/**
 * Clears a stale Next.js dev-server lock, and only a stale one.
 *
 * `next dev` writes `.next/dev/lock` holding the server's pid, and removes it on
 * a clean exit. A hard kill — Ctrl-C at the wrong moment, a crashed compile, a
 * closed terminal, a container timeout — leaves it behind.
 *
 * Normally that is survivable: Next notices the lock, reads the pid, and either
 * connects you to the still-running server or tells you which pid to kill. But
 * acquiring the lock goes through a native call that throws EACCES instead of
 * reporting "not acquired" when the project sits on a filesystem without
 * working POSIX record locks (WSL's drvfs/9p mount of a Windows drive is the
 * common case). The throw is fatal and unhelpful:
 *
 *   Error: An IO error occurred while attempting to create and acquire the lockfile
 *     [cause]: Error: Permission denied (os error 13)
 *
 * ...and the dev server exits before it ever binds a port, so every subsequent
 * `npm run dev` fails the same way until the file is removed by hand.
 *
 * This runs as `predev`. It removes the lock only when the recorded pid is
 * provably gone, so it can never stomp a dev server that is actually running —
 * in that case the lock is left alone and Next prints its own guidance.
 */
import fs from "node:fs";
import path from "node:path";

const lockPath = path.join(process.cwd(), ".next", "dev", "lock");

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering
    // anything. EPERM means the pid exists but belongs to another user, which
    // still counts as alive.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

if (!fs.existsSync(lockPath)) {
  process.exit(0);
}

let pid = null;
try {
  pid = JSON.parse(fs.readFileSync(lockPath, "utf8")).pid ?? null;
} catch {
  // Unreadable or corrupt: it cannot be describing a live server we can check.
}

if (pidIsAlive(pid)) {
  // Leave it. Next will report the running server properly.
  process.exit(0);
}

try {
  fs.unlinkSync(lockPath);
  console.log(
    `[dev] removed a stale .next/dev/lock${pid ? ` from dead pid ${pid}` : ""}`,
  );
} catch (error) {
  // Not fatal. If it really is wedged, Next's own error is the thing to read.
  console.warn(`[dev] could not remove ${lockPath}: ${error?.message}`);
}
