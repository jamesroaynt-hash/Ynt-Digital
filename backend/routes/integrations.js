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

  router.get('/pancake/status', (req, res) => {
    res.json(getStatus(db));
  });

  router.get('/pancake-pos/status', (req, res) => {
    res.json(posSync.getStatus(db));
  });

  router.get('/google-sheets/status', (req, res) => {
    res.json(googleSheetsSync.getStatus(db));
  });

  router.post('/pancake/config', (req, res) => {
    const config = saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/pancake-pos/config', (req, res) => {
    const config = posSync.saveSetting(db, req.body || {});
    res.json(config);
  });

  router.post('/google-sheets/config', (req, res) => {
    const config = googleSheetsSync.saveSetting(db, req.body || {});
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

  router.post('/pancake/import', (req, res) => {
    try {
      const result = syncPayload(db, req.body || {}, 'manual');
      res.status(202).json({
        message: 'Pancake data import completed.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/pancake/webhook', (req, res) => {
    const suppliedSecret = req.headers['x-webhook-secret'] || req.query.secret;
    const signature = req.headers['x-pancake-signature'];

    const secretValid = validateWebhookSecret(db, suppliedSecret);
    const signatureValid = signature ? verifyWebhookSignature(db, req.body || {}, signature) : true;
    if (!secretValid || !signatureValid) {
      return res.status(401).json({ error: 'Invalid webhook secret or signature' });
    }

    try {
      const result = syncPayload(db, req.body || {}, 'webhook');
      res.status(202).json({
        message: 'Pancake webhook accepted.',
        ...result,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.get('/pancake/status', (req, res) => {
    res.json(getStatus(db));
  });

  publicRouter.get('/pancake-pos/status', (req, res) => {
    res.json(posSync.getStatus(db));
  });

  publicRouter.get('/google-sheets/status', (req, res) => {
    res.json(googleSheetsSync.getStatus(db));
  });

  publicRouter.post('/pancake/config', (req, res) => {
    try {
      const config = saveSetting(db, req.body || {});
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/pancake-pos/config', (req, res) => {
    try {
      const config = posSync.saveSetting(db, req.body || {});
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/google-sheets/config', (req, res) => {
    try {
      const config = googleSheetsSync.saveSetting(db, req.body || {});
      res.json(config);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/pancake/pages', async (req, res) => {
    try {
      const result = await listPagesFromApi(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/pancake-pos/shops', async (req, res) => {
    try {
      const result = await posSync.listShopsFromApi(db, req.body || {});
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  publicRouter.post('/pancake/collect', async (req, res) => {
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

  publicRouter.post('/pancake-pos/collect', async (req, res) => {
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

  publicRouter.post('/google-sheets/collect', async (req, res) => {
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

  router.publicRouter = publicRouter;
  return router;
};
