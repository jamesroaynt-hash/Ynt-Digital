// The visitor's real IP. Requests reach Express through Cloudflare and Railway's
// edge, so req.ip is a proxy address shared by every user (it made the login
// limiter one bucket for the whole office).
//
//   browser → www Worker → ynterp.work (Cloudflare) → Railway → Express
//
// Cloudflare sets CF-Connecting-IP, but on a Worker subrequest that is the
// Worker's own address, so the Worker forwards the browser's IP as
// X-Client-IP. It is only trusted when Cloudflare marks the request as a
// Worker subrequest (CF-Worker); a direct call gets its CF-Connecting-IP.
const IP_PATTERN = /^[0-9a-f.:]{3,45}$/i;

function header(req, name) {
  const value = String(req.headers?.[name] || '').split(',')[0].trim();
  return IP_PATTERN.test(value) ? value : '';
}

function getClientIp(req) {
  if (req.headers?.['cf-worker']) {
    const forwarded = header(req, 'x-client-ip');
    if (forwarded) return forwarded;
  }
  return header(req, 'cf-connecting-ip')
    || req.ip
    || req.connection?.remoteAddress
    || 'unknown';
}

module.exports = { getClientIp };
