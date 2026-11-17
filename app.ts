// The forge's HTTP server: one process serving git smart HTTP, REST v3,
// GraphQL v4 and MCP from a single in-memory store (src/store.ts).
//
// app.ts is the server; main.ts (the entry <-> env lifecycle) stays as it is.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { notFound, pathOf, sendJson } from './src/util.ts';
import { handleRest } from './src/rest.ts';
import { handleGit } from './src/git.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    void (async () => {
      try {
        if (await handleRest(req, res, store)) return;
        if (await handleMcp(req, res, store)) return;
        if (await handleGit(req, res, store)) return;
        if (await handleGraphql(req, res, store)) return;
        // Unknown route: GitHub's JSON 404.
        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
