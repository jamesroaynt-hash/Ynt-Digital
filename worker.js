const RAILWAY = 'https://ynt-digital-production.up.railway.app';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return fetch(`${RAILWAY}${url.pathname}${url.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
    }

    return env.ASSETS.fetch(request);
  },
};
