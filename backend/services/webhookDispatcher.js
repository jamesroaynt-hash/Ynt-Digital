const crypto = require('crypto');
const https = require('https');
const http = require('http');

function signPayload(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliverToUrl(url, body, secret) {
  const signature = signPayload(secret, body);
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const options = {
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-YNT-Signature': signature,
        'User-Agent': 'YNT-Webhook/1.0',
      },
      timeout: 10000,
    };

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 500) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Webhook delivery timed out')); });
    req.write(body);
    req.end();
  });
}

async function dispatch(db, event, data) {
  let subs;
  try {
    subs = await db.prepare(
      'SELECT id, url, events, secret FROM webhook_subscriptions WHERE is_active = 1'
    ).all();
  } catch {
    return;
  }

  const eligible = (subs || []).filter((sub) => {
    try {
      const events = JSON.parse(sub.events || '[]');
      return events.includes('*') || events.includes(event);
    } catch { return false; }
  });

  if (!eligible.length) return;

  const fullPayload = { event, timestamp: new Date().toISOString(), data };
  const body = JSON.stringify(fullPayload);

  for (const sub of eligible) {
    let deliveryId;
    try {
      const ins = await db.prepare(
        "INSERT INTO webhook_deliveries (subscription_id, event, payload, status, attempts) VALUES (?, ?, ?, 'pending', 0)"
      ).run(sub.id, event, body);
      deliveryId = ins.lastInsertRowid;
    } catch { continue; }

    deliverToUrl(sub.url, body, sub.secret)
      .then(({ status, body: rbody }) => {
        const ok = status >= 200 && status < 300;
        Promise.resolve(db.prepare(
          'UPDATE webhook_deliveries SET status = ?, response_status = ?, response_body = ?, attempts = 1, delivered_at = ? WHERE id = ?'
        ).run(ok ? 'delivered' : 'failed', status, rbody, ok ? new Date().toISOString() : null, deliveryId)).catch(() => {});
      })
      .catch((err) => {
        Promise.resolve(db.prepare(
          "UPDATE webhook_deliveries SET status = 'failed', response_body = ?, attempts = 1 WHERE id = ?"
        ).run(String(err.message).slice(0, 200), deliveryId)).catch(() => {});
      });
  }
}

module.exports = { dispatch, signPayload };
