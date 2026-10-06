/**
 * Host half of the `dsh-rail-tones` bundle.
 *
 * The feature itself lives in the browser half (a read-only observer of the
 * official Turn Rail). This half exists so the plugin can report its own boot
 * state somewhere a plain terminal can read it — the browser half has no other
 * way to say "I mounted, and here is what the settings registration did":
 *
 *   GET  /rail-tones/status   → the last report. **404 means this row is not
 *                               live at all** (the plugin was not composed at
 *                               boot); 401 means the row is live but the route
 *                               sits behind the connection trust fence.
 *   POST /rail-tones/report   → the browser half's report; also mirrored to
 *                               `<home>/.dsh/rail-tones-report.json`.
 *
 * Both routes are read-only side channels for diagnosis; neither affects the
 * sound feature, and deleting the report file is always safe.
 */

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-rail-tones';
export const inject = ['webServer'];

const STATUS_PATH = '/rail-tones/status';
const REPORT_PATH = '/rail-tones/report';
const REPORT_FILE = join(homedir(), '.dsh', 'rail-tones-report.json');
/** Reports are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405;
  res.setHeader('allow', allow);
  res.end();
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function apply(ctx) {
  const state = {
    plugin: 'dsh-rail-tones',
    host: 'live',
    hostAt: new Date().toISOString(),
    report: null,
  };

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: STATUS_PATH,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendMethodNotAllowed(res, 'GET');
          return;
        }
        sendJson(res, 200, state);
      },
    }),
  );

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: REPORT_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res, 'POST');
          return;
        }
        const text = await readBoundedBody(req);
        if (text === null) {
          sendJson(res, 413, { ok: false, error: 'body-too-large' });
          return;
        }
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch (error) {
          payload = null;
        }
        if (payload === null || typeof payload !== 'object') {
          sendJson(res, 400, { ok: false, error: 'invalid-json' });
          return;
        }
        state.report = { receivedAt: new Date().toISOString(), payload };
        try {
          writeFileSync(REPORT_FILE, JSON.stringify(state, null, 2), 'utf8');
        } catch (error) {
          /* 报告文件写不进去不影响任何功能 */
        }
        sendJson(res, 200, { ok: true });
      },
    }),
  );
}
