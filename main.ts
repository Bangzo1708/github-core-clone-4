// Entrypoint. In the trial the environment gives us MAKEFUN_ENV_URL: we bind
// an ephemeral port, register it immediately, answer /healthz, then long-poll
// /done until the trial ends and exit 0. Without it (local development) we
// listen on $PORT and serve forever.

import { createForgeServer } from './app.ts';
import { Store } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL}/register`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
    } catch {
      // The environment may not be ready yet; retry.
    }
    await sleep(250);
  }
  throw new Error('could not register with the trial environment');
}

async function waitDone(): Promise<void> {
  const url = `${ENV_URL}/done`;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {
      // The environment may not be ready yet; keep polling.
    }
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  const store = new Store();
  const server = createForgeServer(store);

  if (ENV_URL !== '') {
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('could not bind a port'));
          return;
        }
        resolve(address.port);
      });
    });
    await register(port);
    await waitDone();
    process.exit(0);
  }

  const port = Number(process.env.PORT ?? 0);
  server.listen(port, '0.0.0.0', () => {
    const address = server.address();
    const actual = address !== null && typeof address !== 'string' ? address.port : port;
    console.log(`forge listening on http://127.0.0.1:${actual}`);
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
