#!/usr/bin/env node
/**
 * A readable live view of the Worker's logs for the terminal.
 *
 * The Worker logs JSON on purpose: the Cloudflare dashboard indexes JSON fields, so you can
 * filter by tool or subject there. JSON is hard to read on a projector though, so this script
 * runs `wrangler tail --format json` and prints one aligned, coloured line per request:
 * the OAuth step by name, the MCP method and tool on each /mcp call, and the tool outcome.
 *
 *   npm run logs                 # tenet-ui-mcp
 *   npm run logs -- <worker>     # another Worker
 */
import { spawn } from 'node:child_process';

const worker = process.argv[2] ?? 'tenet-ui-mcp';
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2'), bold = c('1'), red = c('31'), green = c('32'), yellow = c('33'), blue = c('34'), magenta = c('35'), cyan = c('36');

/** What each non-MCP route means in the OAuth flow. */
function describe(method, path) {
  if (path.startsWith('/.well-known/oauth-protected-resource')) return ['discover', 'protected resource metadata: who issues my tokens?'];
  if (path.startsWith('/.well-known/oauth-authorization-server')) return ['discover', 'authorization server metadata: endpoints, PKCE'];
  if (path === '/register') return ['register', 'dynamic client registration (fallback when no CIMD)'];
  if (path.startsWith('/clients/')) return ['cimd', 'client id metadata document fetched'];
  if (path === '/authorize') return method === 'GET' ? ['authorize', 'login page shown to the user'] : ['authorize', 'user signed in, code issued'];
  if (path === '/token') return ['token', 'code + PKCE verifier exchanged for an access token'];
  if (path === '/health') return ['health', ''];
  if (path === '/') return ['page', 'landing page'];
  return ['', ''];
}

const time = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
const statusColour = (s) => (s >= 500 ? red : s >= 400 ? yellow : green);

function render(ev) {
  const req = ev.event?.request;
  if (!req) return;
  const url = new URL(req.url);
  const status = ev.event?.response?.status ?? 0;
  const head = `${dim(time(ev.eventTimestamp))}  ${statusColour(status)(String(status || '---').padEnd(3))}  ${req.method.padEnd(4)}`;

  if (url.pathname === '/mcp') {
    const h = req.headers ?? {};
    const rpc = h['mcp-method'] ?? '(no Mcp-Method header)';
    const name = h['mcp-name'] ? ` ${bold(h['mcp-name'])}` : '';
    const auth = status === 401 ? yellow('  no or invalid token -> WWW-Authenticate challenge') : '';
    console.log(`${head} ${cyan('/mcp')}  ${magenta(rpc)}${name}${auth}`);
  } else {
    const [step, note] = describe(req.method, url.pathname);
    console.log(`${head} ${blue(url.pathname.padEnd(44))} ${step ? bold(step.padEnd(9)) : ''} ${dim(note)}`);
  }

  for (const entry of ev.logs ?? []) {
    for (const raw of entry.message ?? []) {
      let e;
      try { e = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { console.log(`            ${dim(String(raw))}`); continue; }
      // Event shapes from src/telemetry.ts (tool, resource, auth, request) and the hooks plugin (hook.*).
      if (e?.event === 'tool') {
        const ok = e.status === 'ok' ? green('ok  ') : red('fail');
        console.log(`            ${ok} ${bold(String(e.tool).padEnd(18))} ${String(e.durationMs + 'ms').padStart(6)}  ${dim(e.dsVersion ? 'ds ' + e.dsVersion : '')}${e.code ? red('  ' + e.code) : ''}${e.bytes ? dim('  ' + e.bytes + ' B') : ''}`);
      } else if (e?.event === 'resource') {
        console.log(`            ${dim('read')} ${String(e.uri)} ${dim(e.bytes + ' B')}`);
      } else if (e?.event === 'auth') {
        console.log(`            ${red('auth')} ${e.status} ${e.code}`);
      } else if (e?.event === 'request') {
        if (e.status === 'sdk_error') console.log(`            ${red('err ')} ${e.detail}`);
      } else if (typeof e?.event === 'string' && e.event.startsWith('hook.')) {
        console.log(`            ${dim('hook')} ${e.event} ${dim(e.tool ?? e.after ?? '')}`);
      } else {
        console.log(`            ${dim(JSON.stringify(e))}`);
      }
    }
  }
  for (const ex of ev.exceptions ?? []) console.log(`            ${red('exception')} ${ex.name}: ${ex.message}`);
}

/** wrangler prints concatenated, pretty-printed JSON objects. Split them by tracking brace depth outside strings. */
function makeSplitter(onObject) {
  let buf = '', depth = 0, inStr = false, esc = false, start = -1;
  return (chunk) => {
    for (const ch of chunk) {
      buf += ch;
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth === 0) start = buf.length - 1; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          try { onObject(JSON.parse(buf.slice(start))); } catch { /* not an event */ }
          buf = ''; start = -1;
        }
      }
    }
    if (depth === 0) buf = '';
  };
}

console.log(dim(`tailing ${worker} ... make a request. Ctrl-C to stop. (Sessions expire after about 30 minutes.)`));
const child = spawn('npx', ['wrangler', 'tail', worker, '--format', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] });
const feed = makeSplitter(render);
child.stdout.setEncoding('utf8');
child.stdout.on('data', feed);
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
