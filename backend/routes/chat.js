const express = require('express');

// Server-side proxy for the dashboard's AI chat widget. Keeps the API key on
// the server (never shipped to the browser) and forwards the trimmed
// conversation to an OpenAI-compatible Chat Completions endpoint.
//
// Works with OpenAI or OpenRouter (or any OpenAI-compatible gateway) via env:
//   OPENAI_API_KEY     required — your provider key (OpenAI sk-... or OpenRouter sk-or-...)
//   OPENAI_BASE_URL    optional — defaults to https://api.openai.com/v1
//                      for OpenRouter use https://openrouter.ai/api/v1
//   OPENAI_CHAT_MODEL  optional — e.g. gpt-4o-mini, or for OpenRouter
//                      openai/gpt-4o-mini, anthropic/claude-3.5-haiku, etc.
//   OPENAI_CHAT_SYSTEM optional — system prompt override
module.exports = function chatRoutes() {
  const router = express.Router();

  const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const IS_OPENROUTER = BASE_URL.includes('openrouter.ai');
  // Default to a free OpenRouter model when pointed at OpenRouter and no model
  // is configured; otherwise OpenAI's cheap default. Override with
  // OPENAI_CHAT_MODEL (free OpenRouter ids end in ":free").
  const MODEL = process.env.OPENAI_CHAT_MODEL
    || (IS_OPENROUTER ? 'meta-llama/llama-3.3-70b-instruct:free' : 'gpt-4o-mini');
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

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    // OpenRouter recommends these for attribution; harmless for OpenAI.
    if (IS_OPENROUTER) {
      headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL || 'https://ynt-digital.jamesroa-ynt.workers.dev';
      headers['X-Title'] = 'YNT Dashboard';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const upstream = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
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
        return res.status(502).json({ error: data?.error?.message || `Provider error (${upstream.status})` });
      }
      const reply = String(data?.choices?.[0]?.message?.content || '').trim();
      if (!reply) return res.status(502).json({ error: 'Empty response from provider' });
      res.json({ reply, model: data?.model || MODEL });
    } catch (error) {
      const msg = error.name === 'AbortError' ? 'Chat request timed out' : error.message;
      res.status(500).json({ error: msg });
    } finally {
      clearTimeout(timeout);
    }
  });

  return router;
};
