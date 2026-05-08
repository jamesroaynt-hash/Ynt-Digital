const express = require('express');
const {
  getStatus,
  saveSetting,
  listPagesFromApi,
  collectApiData,
  syncPayload,
  validateWebhookSecret,
  verifyWebhookSignature,
} = require('../services/pancakeSync');
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

  router.use(requireAdmin);

  router.get('/pancake/status', async (req, res) => {
    res.json(await getStatus(db));
  });

  router.get('/pancake-pos/status', async (req, res) => {
    res.json(await posSync.getStatus(db));
  });

  router.get('/google-sheets/status', async (req, res) => {
    res.json(await googleSheetsSync.getStatus(db));
  });

  router.post('/pancake/config', async (req, res) => {
    const config = await saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/pancake-pos/config', async (req, res) => {
    const config = await posSync.saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/google-sheets/config', async (req, res) => {
    const config = await googleSheetsSync.saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/pancake/pages', async (req, res) => {
    try {
      const result = await listPagesFromApi(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake-pos/shops', async (req, res) => {
    try {
      const result = await posSync.listShopsFromApi(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/pancake/collect', async (req, res) => {
    try {
      const result = await collectApiData(db, req.body || {});
      res.status(202).json({
        message: 'Pancake API collection completed.',
        ...result,
      });
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

  router.post('/pancake/import', async (req, res) => {
    try {
      const result = await syncPayload(db, req.body || {}, 'manual');
      res.status(202).json({
        message: 'Pancake data import completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  async function handlePancakeWebhook(req, res) {
    const suppliedSecret = req.headers['x-webhook-secret'] || req.query.secret;
    const signature = req.headers['x-pancake-signature'];

    const secretValid = await validateWebhookSecret(db, suppliedSecret);
    const signatureValid = signature ? await verifyWebhookSignature(db, req.body || {}, signature) : true;
    if (!secretValid || !signatureValid) {
      return res.status(401).json({ error: 'Invalid webhook secret or signature' });
    }

    try {
      const result = await syncPayload(db, req.body || {}, 'webhook');
      res.status(202).json({
        message: 'Pancake webhook accepted.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  publicRouter.post('/pancake/webhook', handlePancakeWebhook);
  publicRouter.post('/pancake-pos/webhook', handlePancakeWebhook);

  publicRouter.get('/pancake/status', async (req, res) => {
    res.json(await getStatus(db));
  });

  publicRouter.get('/pancake-pos/status', async (req, res) => {
    res.json(await posSync.getStatus(db));
  });

  publicRouter.get('/google-sheets/status', async (req, res) => {
    res.json(await googleSheetsSync.getStatus(db));
  });

  publicRouter.post([
    '/pancake/config',
    '/pancake-pos/config',
    '/google-sheets/config',
    '/pancake/pages',
    '/pancake-pos/shops',
    '/pancake/collect',
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

  router.publicRouter = publicRouter;
  return router;
};
