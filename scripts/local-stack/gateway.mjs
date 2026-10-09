// Local-only gateway: one origin for supabase-js, like the hosted project.
//   /auth/v1/*  -> GoTrue   /rest/v1/*  -> PostgREST
// Binds 127.0.0.1 only. Not a public endpoint.
import http from 'node:http';

const authPort = Number(process.env.AUTH_PORT ?? 54321);
const restPort = Number(process.env.REST_PORT ?? 54322);
const port = Number(process.env.GATEWAY_PORT ?? 54320);

function route(url) {
  if (url.startsWith('/auth/v1')) return [authPort, url.slice('/auth/v1'.length)];
  if (url.startsWith('/rest/v1')) return [restPort, url.slice('/rest/v1'.length)];
  return null;
}

http
  .createServer((req, res) => {
    const target = route(req.url ?? '');
    if (!target) {
      res.writeHead(404);
      res.end();
      return;
    }
    const upstream = http.request(
      { host: '127.0.0.1', port: target[0], path: target[1] || '/', method: req.method, headers: { ...req.headers, host: `127.0.0.1:${target[0]}` } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  })
  .listen(port, '127.0.0.1');
