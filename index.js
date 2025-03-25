const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('ws');
const serverController = require('./controllers/serverController');
const { setWebSocketInstance: setDockerWs } = require('./services/dockerService');
const { setWebSocketInstance: setMonitorWs } = require('./services/monitorsService');
const { startStatsStreamingForAllContainers } = require('./services/dockerService');

const config = require('./config/config.json');

const serverRoutes = require('./routes/serverRoutes');
const monitoringRoutes = require('./routes/monitoringRoutes');
const rconRoutes = require('./routes/rconRoutes'); // Préparé !

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

// Attach WebSocket instances to Docker & Monitor services
setDockerWs(wss);
setMonitorWs(wss);

// Start real-time Docker stats streaming
startStatsStreamingForAllContainers();

/*========================= Middleware =========================*/
app.use('/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));
app.use('/handlebars', express.static(path.join(__dirname, 'node_modules/handlebars/dist')));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/*========================= Frontend =========================*/
app.get('/', async (req, res) => {
    const statusData = await serverController.fetchAllServersStatus();
    res.render('index', { servers: statusData.servers, hostStats: statusData.hostStats });
});

app.get('/servers', (req, res) => {
    res.render('servers');
});

app.get("/templates/:filename", (req, res) => {
    const filename = req.params.filename;
    if (!filename.match(/^[a-zA-Z0-9_-]+\.hbs$/)) {
        return res.status(400).send("Invalid file request.");
    }
    const filePath = path.join(__dirname, "public", "templates", filename);
    res.sendFile(filePath);
});

/*========================= API Routes =========================*/
app.use('/api/server', serverRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/rcon', rconRoutes);

// GET maps
app.get('/api/maps', serverController.getAvailableMaps);

/*========================= Server Init =========================*/
const PORT = config.webSocketPort || 8080;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);

    // ➤ Premier push du status général à l'init (sans polling)
    (async () => {
        const statusData = await serverController.fetchAllServersStatus();
        serverController.broadcastServerUpdate(wss, statusData);
    })();
});
