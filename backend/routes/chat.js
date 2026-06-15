const express = require('express');

// Server-side proxy for the dashboard's AI chat widget. Keeps the OpenAI API
// key on the server (never shipped to the browser) and forwards the trimmed
// conversation to OpenAI's Chat Completions API.
module.exports = function chatRoutes() {
  const router = express.Router();

  const MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';
  const SYSTEM_PROMPT = process.env.OPENAI_CHAT_SYSTEM
    || 'You are a helpful assistant embedded in the YNT operations dashboard. Be concise, friendly, and practical.';

  router.post('/', async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Chat is not configured. Set OPENAI_API_KEY on the server.' });
    }

    // Only forward user/assistant turns, cap history and message length so a
    // crafted client can't blow up the token bill.
    const incoming = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const messages = incoming
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length) return res.status(400).json({ error: 'messages required' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
          temperature: 0.7,
          max_tokens: 800,
        }),
        signal: controller.signal,
      });
      const data = await upstream.json().catch(() => null);
      if (!upstream.ok) {
        return res.status(502).json({ error: data?.error?.message || `OpenAI error (${upstream.status})` });
      }
      const reply = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!reply) return res.status(502).json({ error: 'Empty response from OpenAI' });
      res.json({ reply, model: MODEL });
    } catch (error) {
      const msg = error.name === 'AbortError' ? 'Chat request timed out' : error.message;
      res.status(500).json({ error: msg });
    } finally {
      clearTimeout(timeout);
    }
  });

  return router;
};
