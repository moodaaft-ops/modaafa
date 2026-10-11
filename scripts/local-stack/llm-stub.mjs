// Local stand-in for the Anthropic API (models list + one non-streaming message).
// Lets the chat routes run with no real key and no spend. Binds 127.0.0.1 only.
// GET /__calls returns how many model calls were made.
import http from 'node:http';

const port = Number(process.env.LLM_STUB_PORT ?? 54330);
let calls = 0;

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const url = req.url ?? '';
      if (url.startsWith('/v1/models')) {
        const data = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'].map((id) => ({
          type: 'model',
          id,
          display_name: id,
          created_at: '2026-01-01T00:00:00Z',
        }));
        res.end(JSON.stringify({ data, has_more: false, first_id: null, last_id: null }));
        return;
      }
      if (url.startsWith('/v1/messages')) {
        calls += 1;
        let model = 'claude-sonnet-5-5';
        try {
          model = JSON.parse(body).model || model;
        } catch {
          /* keep default */
        }
        res.end(
          JSON.stringify({
            id: `msg_stub${calls}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [{ type: 'text', text: `local stub reply ${calls}` }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 8 },
          })
        );
        return;
      }
      if (url === '/__calls') {
        res.end(String(calls));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  })
  .listen(port, '127.0.0.1');
