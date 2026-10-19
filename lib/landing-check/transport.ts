import { request } from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import type { Resolver } from './ssrf';
import type { Transport } from './fetch';

/**
 * Production DNS: every A and AAAA answer, unmodified, so the SSRF guard can
 * judge all of them.
 */
export const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

/**
 * Production transport. The connection is pinned to the address the guard
 * already checked (the `lookup` override returns it and nothing else), so a
 * second DNS answer cannot swap in a private address between the check and
 * the connect (DNS rebinding). TLS still validates the certificate against the
 * real host name.
 */
export const pinnedHttpsTransport: Transport = ({ url, address, headers, signal }) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        servername: url.hostname,
        port: 443,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
        signal,
        lookup: (_hostname, options, callback) => {
          if (options && (options as { all?: boolean }).all) {
            (callback as unknown as (e: Error | null, a: Array<{ address: string; family: number }>) => void)(null, [
              { address: address.address, family: address.family },
            ]);
          } else {
            callback(null, address.address, address.family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (name.toLowerCase() === 'set-cookie') continue; // no cookie jar, ever
          if (Array.isArray(value)) value.forEach((v) => responseHeaders.append(name, v));
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const nullBody = status < 200 || status === 204 || status === 205 || status === 304;
        if (status < 200 || status > 599) {
          res.destroy();
          reject(new Error('unsupported_status'));
          return;
        }
        resolve(
          new Response(nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), {
            status,
            headers: responseHeaders,
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
