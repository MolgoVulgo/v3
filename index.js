/**
 * @file index.js
 * @description Main server file that sets up the Express application, WebSocket server,
 * and routes for managing servers.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('ws');
const serverController = require('./controllers/serverController');
const config = require('./config/config.json');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

/*=======================================================================
 *                        Middleware Configuration
 *======================================================================*/

// Serve Bootstrap and Handlebars from node_modules
app.use('/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));
app.use('/handlebars', express.static(path.join(__dirname, 'node_modules/handlebars/dist')));

// Set EJS as the templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files

/*=======================================================================
 *                        Front-end Routes
 *======================================================================*/

/**
 * GET /
 * Displays the dashboard page.
 * @param {express.Request} req - Express request object.
 * @param {express.Response} res - Express response object.
 */
app.get('/', async (req, res) => {
    const servers = await serverController.getAllServersStatus();
    res.render('index', { servers });
});

/**
 * GET /servers
 * Displays the server management page.
 * @param {express.Request} req - Express request object.
 * @param {express.Response} res - Express response object.
 */
app.get('/servers', (req, res) => {
    res.render('servers');
});

/**
 * GET /templates/:filename
 * Retrieves a Handlebars template file.
 * @param {express.Request} req 
 * @param {express.Response} res 
 */
app.get("/templates/:filename", (req, res) => {
    const filename = req.params.filename;

    // Security check: prevent directory traversal
    if (!filename.match(/^[a-zA-Z0-9_-]+\.hbs$/)) {
        return res.status(400).send("Invalid file request.");
    }

    const filePath = path.join(__dirname, "public", "templates", filename);
    res.sendFile(filePath);
});

/*=======================================================================
 *                       API Routes for Servers
 *======================================================================*/

// GET all servers
app.get('/api/servers', serverController.getServers);

// POST add a new server
app.post('/api/servers', serverController.addServer);

// DELETE server by name
app.delete('/api/servers/:serverName', serverController.deleteServer);

// GET specific server details
app.get('/api/servers/:serverName', serverController.getServerByName);

// PUT update an existing server
app.put('/api/servers/:serverName', serverController.updateServer);

// POST start server
app.post("/api/servers/:serverName/start", serverController.startServer);

// (Optional GET route for start, if used by client)
app.get("/api/servers/:serverName/start", serverController.startServer);

// POST stop server
app.post("/api/servers/:serverName/stop", serverController.stopServer);

// POST restart server
app.post("/api/servers/:serverName/restart", serverController.restartServer);

// GET server status
app.get("/api/servers/:serverName/status", serverController.getStatus);

// GET all server status
app.get("/api/servers/status", serverController.getAllServersStatus);

/*=======================================================================
 *                       Other API Routes
 *======================================================================*/

/**
 * GET /api/maps
 * Retrieves the list of available maps.
 * @param {express.Request} req 
 * @param {express.Response} res 
 */
app.get('/api/maps', serverController.getAvailableMaps);

/*=======================================================================
 *                        Server Initialization
 *======================================================================*/

/**
 * Starts the HTTP server and launches periodic server status checks.
 */
const PORT = config.webSocketPort || 8080;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    serverController.startPeriodicCheck(wss);
});
