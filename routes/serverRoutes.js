const express = require('express');
const router = express.Router();
const serverController = require('../controllers/serverController');

// CRUD routes
router.get('/', serverController.getServers);
router.post('/', serverController.addServer);
router.get('/:serverName', serverController.getServerByName);
router.put('/:serverName', serverController.updateServer);
router.delete('/:serverName', serverController.deleteServer);

// Action routes
router.post('/:serverName/action/start', serverController.startServer);
router.post('/:serverName/action/stop', serverController.stopServer);
router.post('/:serverName/action/restart', serverController.restartServer);

module.exports = router;
