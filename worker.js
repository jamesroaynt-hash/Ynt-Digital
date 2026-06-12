const RAILWAY = 'https://ynt-digital-marketing.up.railway.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        const headers = new Headers(request.headers);
        headers.delete('host');

        const hasBody = !['GET', 'HEAD'].includes(request.method);
        const body = hasBody ? await request.arrayBuffer() : undefined;

        const response = await fetch(`${RAILWAY}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: hasBody && body.byteLength > 0 ? body : undefined,
        });

        return response;
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error', detail: err.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
