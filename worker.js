const RAILWAY = 'https://ynt-digital-production.up.railway.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers(request.headers);
      headers.delete('host');

      return fetch(`${RAILWAY}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
        redirect: 'follow',
      });
    }

    return env.ASSETS.fetch(request);
  },
};
