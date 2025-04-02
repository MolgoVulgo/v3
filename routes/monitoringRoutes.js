const express = require('express');
const router = express.Router();
const serverController = require('../controllers/serverController');

// Monitoring routes
router.get('/status', serverController.getAllServersStatus);

module.exports = router;
