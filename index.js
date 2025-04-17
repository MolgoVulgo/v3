/**
 * @fileoverview Main application file for the ARK ASA Server Management tool.
 * Initializes Express, WebSocket server, monitoring, routes, and starts the server.
 * @version 1.1.0 Refactored WebSocket initialization for services.
 */

// Core Node.js modules
const http = require('http');
const path = require('path');
const fs = require('fs'); // Needed for checking template file existence
require('dotenv').config(); // Charge les variables depuis le fichier .env dans process.env

// Third-party modules
const express = require('express');
const { Server: WebSocketServer } = require('ws'); // Renamed to avoid conflict with http.Server

// Application modules
const serverController = require('./controllers/serverController');
const { setWebSocketInstance: setMonitorWs, initMonitoring } = require('./services/monitorsService');
//const config = require('./config/config.json');

// Route modules
const serverRoutes = require('./routes/serverRoutes');
const monitoringRoutes = require('./routes/monitoringRoutes');
const rconRoutes = require('./routes/rconRoutes'); // RCON routes (placeholder)

/**
 * Initialize Express application
 * @type {import('express').Application}
 */
const app = express();

/**
 * Create HTTP server instance wrapping the Express app.
 * @type {http.Server}
 */
const server = http.createServer(app);

/**
 * Create WebSocket server instance attached to the HTTP server.
 * @type {WebSocketServer}
 */
const wss = new WebSocketServer({ server });

// Provide the WebSocket instance ONLY to the monitoring service
setMonitorWs(wss);

/**
 * Asynchronous function to initialize the monitoring service on startup.
 * Handles initial cache population and starts background monitoring tasks.
 */
(async () => {
    try {
        console.log("[Index] Initializing monitoring service...");
        await initMonitoring();
        console.log("✅ Monitoring initialized successfully via index.js.");
    } catch (error) {
        console.error("❌ Failed to initialize monitoring from index.js:", error);
        // Consider if the app should exit or continue with degraded functionality
    }
})(); // Self-invoking async function

/*========================= Middleware Configuration =========================*/

// Serve static files from node_modules
app.use('/bootstrap', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));
app.use('/handlebars', express.static(path.join(__dirname, 'node_modules/handlebars/dist'))); // For client-side templates
app.use('/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist'))); // If charts are used client-side

// Set view engine to EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Parse JSON request bodies
app.use(express.json());

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Consider adding security middleware like helmet:
// const helmet = require('helmet');
// app.use(helmet());

// Consider adding request logging middleware like morgan:
// const morgan = require('morgan');
// app.use(morgan('dev')); // Or 'combined'

/*========================= Frontend Routes =========================*/

/**
 * Route for the main dashboard page.
 * Fetches current server statuses and host stats to render the index view.
 */
app.get('/', async (req, res, next) => { // Added next for error handling potential
    try {
        const statusData = await serverController.fetchAllServersStatus();
        // Provide default structure if stats are temporarily unavailable
        const hostStats = statusData.hostStats || { CPU_USAGE: 'N/A', MEMORY_USAGE: { used: 0, total: 0 } };
        res.render('index', { servers: statusData.servers || {}, hostStats: hostStats });
    } catch (error) {
        console.error("❌ Error rendering index page:", error);
        // Basic error rendering, could be improved with a dedicated error page/handler
        res.status(500).render('index', {
            servers: {},
            hostStats: { CPU_USAGE: 'N/A', MEMORY_USAGE: { used: 0, total: 0 }},
            error: "Failed to load server data. Please try again later."
        });
        // Optionally pass to an error handling middleware: next(error);
    }
});

/**
 * Route for the server management page.
 */
app.get('/servers', (req, res) => {
    // Consider fetching server list here if needed for the management page itself
    res.render('servers');
});

/**
 * Route to serve client-side Handlebars templates.
 * Includes basic validation and checks for file existence.
 */
app.get("/templates/:filename", (req, res) => {
    const filename = req.params.filename;
    // Simple validation for .hbs extension and basic characters
    if (!filename.match(/^[a-zA-Z0-9_-]+\.hbs$/)) {
        return res.status(400).send("Invalid template filename.");
    }
    const filePath = path.join(__dirname, "public", "templates", filename);

    // Check if file exists before sending
    fs.access(filePath, fs.constants.R_OK, (err) => {
        if (err) {
            console.warn(`[Templates] Requested template not found or not readable: ${filename}`);
            return res.status(404).send("Template not found.");
        }
        res.sendFile(filePath);
    });
});

/*========================= API Routes =========================*/

// Mount API routers
app.use('/api/server', serverRoutes);
app.use('/api/monitoring', monitoringRoutes);
app.use('/api/rcon', rconRoutes); // RCON API endpoints

// Specific endpoint for available maps
// Could be moved into serverRoutes if preferred
app.get('/api/maps', serverController.getAvailableMaps);

/*========================= Error Handling (Basic Example) =========================*/

// Basic catch-all error handler (Place AFTER all routes)
// A more robust solution would involve specific error types and logging.
// app.use((err, req, res, next) => {
//   console.error("❌ Unhandled Error:", err.stack || err.message);
//   res.status(err.status || 500).json({
//     error: {
//       message: err.message || 'Internal Server Error',
//       // Optionally include stack trace in development
//       stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
//     }
//   });
// });


/*========================= Server Initialization =========================*/

// Define port from config or default to 8080
const PORT = process.env.WEBSOCKET_PORT || 8080;

// Start the HTTP server (which also hosts the WebSocket server)
server.listen(PORT, () => {
    console.log(`🚀 Server running and listening on http://localhost:${PORT}`);

    // Perform initial status broadcast shortly after startup
    // Gives monitoring a moment to potentially get initial data
    setTimeout(async () => {
        try {
            console.log("[Index] Performing initial status broadcast...");
            const statusData = await serverController.fetchAllServersStatus();
            // Use the controller's broadcast function to send data via WebSocket
            serverController.broadcastServerUpdate(wss, statusData);
            console.log("[Index] Initial status broadcast complete.");
        } catch (error) {
            console.error("❌ Error during initial status broadcast:", error);
        }
    }, 1500); // Delay in milliseconds (e.g., 1.5 seconds)
});

// Optional: Handle graceful shutdown
// process.on('SIGINT', () => {
//   console.log('SIGINT signal received: closing HTTP server');
//   wss.close(() => {
//     console.log('WebSocket server closed');
//   });
//   server.close(() => {
//     console.log('HTTP server closed');
//     // Close other resources like RCON connections if necessary
//     process.exit(0);
//   });
// });