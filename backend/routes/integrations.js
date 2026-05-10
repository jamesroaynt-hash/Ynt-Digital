const express = require('express');
const posSync = require('../services/pancakePosSync');
const googleSheetsSync = require('../services/googleSheetsSync');

module.exports = function integrationRoutes(db) {
  const router = express.Router();
  const publicRouter = express.Router();

  function requireAdmin(req, res, next) {
    if (String(req.user?.role || '').trim() !== 'Administrator') {
      return res.status(403).json({ error: 'Administrator access required' });
    }
    return next();
  }

  function cronSecretAllowed(req) {
    const expected = process.env.CRON_SECRET;
    if (!expected) return true;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    return bearer === expected || req.query.secret === expected;
  }

  async function pancakeWebhookAllowed(req) {
    const setting = await posSync.getPublicSetting(db);
    const expected = process.env.PANCAKE_POS_WEBHOOK_SECRET || setting.webhook_secret;
    if (!expected) return true;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    return bearer === expected
      || req.headers['x-pancake-signature'] === expected
      || req.headers['x-webhook-secret'] === expected
      || req.query.secret === expected;
  }

  router.use(requireAdmin);

  router.get('/pancake-pos/status', async (req, res) => {
    res.json(await posSync.getStatus(db));
  });

  router.get('/google-sheets/status', async (req, res) => {
    res.json(await googleSheetsSync.getStatus(db));
  });

  router.post('/pancake-pos/config', async (req, res) => {
    const config = await posSync.saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/google-sheets/config', async (req, res) => {
    const config = await googleSheetsSync.saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/pancake-pos/shops', async (req, res) => {
    try {
      const result = await posSync.listShopsFromApi(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/collect', async (req, res) => {
    try {
      const result = await posSync.collectPosData(db, req.body || {});
      res.status(202).json({
        message: 'Pancake POS data collection completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/google-sheets/collect', async (req, res) => {
    try {
      const result = await googleSheetsSync.collectSheetData(db, req.body || {});
      res.status(202).json({
        message: 'Google Sheets data sync completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.get('/pancake-pos/status', async (req, res) => {
    res.json(await posSync.getStatus(db));
  });

  publicRouter.get('/google-sheets/status', async (req, res) => {
    res.json(await googleSheetsSync.getStatus(db));
  });

  publicRouter.post([
    '/pancake-pos/config',
    '/google-sheets/config',
    '/pancake-pos/shops',
    '/pancake-pos/collect',
    '/google-sheets/collect',
  ], (req, res) => {
    res.status(403).json({ error: 'Administrator access required' });
  });

  publicRouter.get('/google-sheets/cron', async (req, res) => {
    if (!cronSecretAllowed(req)) {
      return res.status(401).json({ error: 'Invalid cron secret' });
    }

    try {
      const result = await googleSheetsSync.runScheduledSync(db);
      res.status(202).json({
        message: result?.skipped ? 'Google Sheets scheduled sync skipped.' : 'Google Sheets scheduled sync completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/pancake-pos/webhook', async (req, res) => {
    if (!(await pancakeWebhookAllowed(req))) {
      return res.status(401).json({ error: 'Invalid Pancake POS webhook secret' });
    }

    try {
      const result = await posSync.receiveWebhook(db, req.body || {});
      res.status(202).json({
        message: 'Pancake POS webhook received.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.publicRouter = publicRouter;
  return router;
};
