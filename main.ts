// Entry lifecycle for the forge.
//
// The trial environment owns port 8080 and drives the run. This process
// only has three jobs: start the forge on a port the kernel picks, tell
// the environment which port that is, and stay alive until the environment
// says the trial is finished. Nothing else in this file does scoring;
// the server built by app.ts is what the suite exercises.
//
// The sequence, in order:
//   - Read MAKEFUN_ENV_URL. With no env origin there is nothing to
//     register with, so print a line to stderr and exit 1 at once.
//   - Build the server from app.ts and listen on port 0. The kernel
//     chooses a free ephemeral port. Port 8080 is never bound here.
//   - POST the chosen port to $MAKEFUN_ENV_URL/register as {"port": N}.
//     200 is the normal reply. 409 means a first registration already
//     won, which is fine, this process just waits like any other. 400
//     and 405 are contract errors and end the program. Any other reply,
//     or a network failure, is retried, because the env may still be
//     starting up.
//   - GET $MAKEFUN_ENV_URL/done again and again until it answers
//     {"done": true}. While the suite runs it answers {"done": false}
//     straight away, so this is a poll, not a held request. A poll that
//     fails or is slow is retried the same way; the process never exits
//     before the env says it is done.
//   - Close the server and exit 0. The harness then stops the env,
//     which writes the export the scorer reads.
//
// Only ./app.ts is imported. No packages, no Node built-ins, no model
// calls, no outside service is used by this file.

import { createApp } from './app.ts';

// The env origin, with any trailing slashes stripped, so joining paths
// below never produces a double slash.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, there is no env to register with\n');
  process.exit(1);
}

// One register or done request gets this long before it is abandoned
// and retried.
const requestTimeoutMs = 30_000;
// Retries start this far apart and never wait longer than this.
const firstRetryMs = 250;
const longestRetryMs = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// How long to wait after the nth failed attempt: double from the first
// retry each time, capped, with the exponent itself capped so the
// doubling never runs away.
function backoffMs(failures: number): number {
  const step = Math.min(failures, 8);
  return Math.min(longestRetryMs, firstRetryMs * 2 ** step);
}

// Tell the env the port we bound. Returns once the env has accepted it,
// or once a 409 says another entry registered first. Throws only on a
// 400 or 405, which are contract errors, not transient ones.
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (reply.status === 200 || reply.status === 409) {
        return;
      }
      if (reply.status === 400 || reply.status === 405) {
        const detail = await reply.text();
        throw new Error(`register replied HTTP ${reply.status}: ${detail}`);
      }
      // Any other status: the env may still be starting, so fall
      // through to the retry wait below.
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register replied HTTP ')) {
        throw error;
      }
      // A network error or a timeout: also just retry.
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

// Keep asking the env whether the trial is over. Returns only when it
// answers {"done": true}. A failed poll, a slow poll, or a "not yet"
// answer all mean the same thing here: wait a little, then ask again.
async function awaitDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) {
          return;
        }
      }
    } catch {
      // The env is not answering yet. That is not "done", so poll again.
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

// Bind, register, then wait for done: the whole life of the process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[entry] registered, waiting for the env to say done\n');

  await awaitDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[entry] ${message}\n`);
  process.exit(1);
}
