const express = require('express');
const router = express.Router();

// Placeholder
router.post('/:serverName/command', (req, res) => {
    res.status(501).json({ message: 'RCON command execution not implemented yet.' });
});

module.exports = router;
