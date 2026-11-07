// @nexus/ui-brand — host half.
// The Nexus product identity is browser presentation: the client half
// (lib/client.js) fills the brand slots and stacks the Nexus theme tokens.
//
// DSH 0.2.x: brand images used to be copied into the upstream web frontend
// `dist/assets` by a string-patch installer. Writing inside
// node_modules/@deepseek-ai is unsupported, so this host half serves its own
// two PNGs from the package directory on exact routes of the official
// webServer registry instead (admitted through ctx.connection like /api: Host/Origin fence + token cookie):
//   GET /nexus/assets/nexus-mark.png
//   GET /nexus/assets/nexus-logo.png
// Profiles without a webServer (tui, headless) load this row harmlessly: the
// route half is bound through Cordis lifecycle injection and never activates
// without the service.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const name = "nexus-ui-brand";
const ASSETS = Object.freeze(['nexus-mark.png', 'nexus-logo.png', 'nexus-favicon.svg']);
const contentTypeOf = (file) => (file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
const assetDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/** Host plugin body — brand assets only; no state, no writes. */
function apply(ctx) {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    for (const file of ASSETS) {
      let bytes = null
      const serve = (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' })
          res.end('method not allowed')
          return
        }
        try {
          bytes = bytes ?? readFileSync(join(assetDirectory, file))
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('not found')
          return
        }
        res.writeHead(200, { 'Content-Type': contentTypeOf(file), 'Cache-Control': 'private, max-age=3600', 'Content-Length': String(bytes.length) })
        res.end(req.method === 'HEAD' ? undefined : bytes)
      }
      const handler = (req, res) => {
        const connection = webCtx.connection
        const verdict = connection && typeof connection.admit === 'function' ? connection.admit(req) : { rejection: 503 }
        if (verdict && 'rejection' in verdict) {
          res.writeHead(verdict.rejection, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end('not admitted')
          return
        }
        serve(req, res)
      }
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: '/nexus/assets/' + file, handler }),
        'nexus-ui-brand: ' + file,
      )
    }
  })
}

export { apply, name };
