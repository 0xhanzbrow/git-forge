// Forge entrypoint: the trial harness talks to this process through the
// environment origin in MAKEFUN_ENV_URL, and this file owns that whole
// handshake. The forge itself lives in app.ts; nothing here answers API
// traffic, it only gets the forge onto a port the harness can reach and
// keeps the process alive until the harness says the trial is finished.
// The order of operations, and why each step is shaped the way it is:
//   * The environment origin must be present. With no origin there is no
//     harness to announce ourselves to, so fail fast with exit code 1
//     instead of binding a port nobody will ever dial.
//   * Bind port 0 and let the kernel hand us a free one. Port 8080 is the
//     environment's own listener on the same loopback, so binding it
//     would collide with the very service we need to talk to.
//   * Announce the bound port with POST <origin>/register and a JSON
//     body carrying just that port. The harness records the peer address
//     of that request together with the port as our base URL. A 409
//     means some other entry already won the first registration; that is
//     not an error we can repair, so we simply carry on waiting.
//   * Poll GET <origin>/done until it reports done. The harness answers
//     every poll immediately, false while the suite is still running and
//     true once its export is written, so this is a plain poll loop.
//     Any failed poll is retried after a short backoff; the process must
//     never exit while the answer is still false.
//   * Once done is true, close the listener and finish with exit code 0.
//     The harness then stops the environment, which is what writes the
//     export the scorer reads, so exiting early would lose the score.
import { createApp } from "./app.ts";
import { setTimeout as pause } from "node:timers/promises";
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const REQUEST_LIMIT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;
const MAX_BACKOFF_STEP = 8;
function backoffMs(failures: number): number {
  const step = failures < MAX_BACKOFF_STEP ? failures : MAX_BACKOFF_STEP;
  const wanted = BACKOFF_START_MS * 2 ** step;
  return wanted < BACKOFF_CAP_MS ? wanted : BACKOFF_CAP_MS;
}
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${ENV_ORIGIN}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (response.status === 200 || response.status === 409) {
        return;
      }
      if (response.status === 400 || response.status === 405) {
        const detail = await response.text();
        throw new Error(`registration rejected with HTTP ${response.status}: ${detail}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("registration rejected")) {
        throw error;
      }
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}
async function awaitCompletion(): Promise<void> {
  let failures = 0;
  while (true) {
    try {
      const response = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (response.ok) {
        const payload = (await response.json()) as { done?: unknown };
        if (payload.done === true) {
          return;
        }
      }
    } catch {
      // No answer, or the poll ran past its deadline: the trial is not
      // over, so fall through to the backoff and poll again.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}
async function boot(): Promise<number> {
  if (ENV_ORIGIN.length === 0) {
    process.stderr.write("[entry] MAKEFUN_ENV_URL is empty: no environment to register with\n");
    return 1;
  }
  const forge = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    forge.once("error", reject);
    forge.listen(0, () => {
      const bound = forge.address();
      if (bound === null || typeof bound === "string") {
        reject(new Error("the forge did not bind a TCP port"));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[entry] forge listening on port ${port}\n`);
  await announcePort(port);
  process.stdout.write("[entry] registered with the environment; waiting for completion\n");
  await awaitCompletion();
  forge.close(() => undefined);
  process.stdout.write("[entry] trial complete, shutting down\n");
  return 0;
}
process.exitCode = await boot().catch((error: unknown) => {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
