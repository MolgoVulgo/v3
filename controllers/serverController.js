const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const dockerService = require("../services/dockerService");
const monitorsService = require("../services/monitorsService");

dotenv.config();
const configPath = path.join(__dirname, '../config/config.json');
const availableMaps = process.env.AVAILABLE_MAPS.split(',');

let intervalId = null;

/*=======================================================================
 *                         CONFIGURATION FUNCTIONS
 *======================================================================*/

/**
 * Retrieves the server configuration by its name.
 * @param {string} serverName - Name of the server.
 * @returns {Object|null} Server config object or null if not found.
 */
function getServerConfig(serverName) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config.SERVERS.find(s => s.SERVER_NAME === serverName) || null;
}

/**
 * Retrieves the list of all servers.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response containing the list of servers.
 */
function getServers(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        res.json(config.SERVERS);
    } catch (error) {
        console.error("Error reading config.json:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Retrieves a specific server by its name from the configuration file.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response with the server data or an error message.
 */
function getServerByName(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const server = config.SERVERS.find(s => s.SERVER_NAME === req.params.serverName);

        if (!server) {
            return res.status(404).json({ error: "Server not found" });
        }

        res.json(server);
    } catch (error) {
        console.error("Error fetching server:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Adds a new server with validation.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response with the added server or an error message.
 */
function addServer(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const newServer = req.body;

        if (config.SERVERS.some(server => server.SERVER_NAME === newServer.SERVER_NAME)) {
            return res.status(400).json({ error: "SERVER_NAME must be unique" });
        }

        if (!newServer.MAP_NAME.endsWith("_WP")) {
            newServer.MAP_NAME += "_WP";
        }

        // Dynamic port generation
        const usedPorts = config.SERVERS.map(s => s.PORT);
        const usedRconPorts = config.SERVERS.map(s => s.RCON_PORT);

        let newPort = parseInt(process.env.BASE_PORT, 10);
        while (usedPorts.includes(newPort)) newPort++;

        let newRconPort = parseInt(process.env.BASE_RCON_PORT, 10);
        while (usedRconPorts.includes(newRconPort)) newRconPort++;

        newServer.PORT = newPort;
        newServer.RCON_PORT = newRconPort;
        newServer.ENABLED = true;

        config.SERVERS.push(newServer);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        res.status(201).json({ message: "Server added", server: newServer });
    } catch (error) {
        console.error("Error adding server:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Updates an existing server configuration.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response with the updated server or an error message.
 */
function updateServer(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const serverIndex = config.SERVERS.findIndex(s => s.SERVER_NAME === req.params.serverName);

        if (serverIndex === -1) {
            return res.status(404).json({ error: "Server not found" });
        }

        config.SERVERS[serverIndex] = { ...config.SERVERS[serverIndex], ...req.body };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        res.json({ message: "Server updated", server: config.SERVERS[serverIndex] });
    } catch (error) {
        console.error("Error updating server:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Deletes a server configuration.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response confirming deletion or error.
 */
function deleteServer(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const serverName = req.params.serverName;

        if (!config.SERVERS.some(server => server.SERVER_NAME === serverName)) {
            return res.status(404).json({ error: "Server not found" });
        }

        config.SERVERS = config.SERVERS.filter(server => server.SERVER_NAME !== serverName);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        res.status(200).json({ message: "Server deleted" });
    } catch (error) {
        console.error("Error deleting server:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Retrieves the list of available maps.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response containing map names.
 */
function getAvailableMaps(req, res) {
    res.json(availableMaps);
}

/*=======================================================================
 *                           DOCKER & MONITOR FUNCTIONS
 *======================================================================*/

/**
 * Starts a specific Ark ASA server and triggers monitoring.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response confirming the start action.
 */
async function startServer(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const server = config.SERVERS.find(s => s.SERVER_NAME === req.params.serverName);

        if (!server) {
            return res.status(404).json({ error: "Server not found" });
        }

        console.log(server.SERVER_NAME);

        // Start Docker server
        dockerService.executeStartServer(server.SERVER_NAME);

        // Start Monitoring
        monitorsService.monitorServerState(server.SERVER_NAME);

        res.json({ message: `Server ${server.SERVER_NAME} is starting.` });
    } catch (error) {
        console.error("Error starting server:", error);
        res.status(500).json({ error: "Failed to start server" });
    }
}

/**
 * Stops an Ark ASA server.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response confirming the stop action.
 */
async function stopServer(req, res) {
    try {
        await dockerService.executeStopServer(req.params.serverName);
        res.status(200).json({ message: `Server ${req.params.serverName} stopped.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

/**
 * Restarts an Ark ASA server and triggers monitoring.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response confirming restart action.
 */
async function restartServer(req, res) {
    try {
        const serverName = req.params.serverName;
        const server = getServerConfig(serverName);

        if (!server) {
            return res.status(404).json({ error: "Server not found" });
        }

        await dockerService.executeRestartServer(server);

        // Start monitoring after Docker restart
        monitorsService.monitorServerState(serverName);

        res.json({ message: `Server ${serverName} is restarting...` });
    } catch (error) {
        console.error(`Error restarting server ${req.params.serverName}:`, error.message);
        res.status(500).json({ error: "Failed to restart server" });
    }
}

/**
 * Retrieves the status (ON/OFF) of a specific server.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response with server status.
 */
async function getStatus(req, res) {
    try {
        const serverName = req.params.serverName;
        const status = dockerService.isServerRunning(serverName); // Returns: off / startup / running
        res.json({ status });
    } catch (error) {
        console.error("Error checking server status:", error);
        res.status(500).json({ error: "Failed to get server status" });
    }
}

/**
 * Starts periodic checking of servers and broadcasts their status via WebSocket.
 * @param {Object} wss - WebSocket server instance.
 * @returns {void}
 */
function startPeriodicCheck(wss) {
    if (intervalId) clearInterval(intervalId);

    intervalId = setInterval(async () => {
        const serversStatus = await getAllServersStatus();
        broadcastServerUpdate(wss, serversStatus);
    }, 10000); // Interval in ms (10 sec)
}


/**
 * Returns the status and stats of all servers + host stats.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 */
async function getAllServersStatus(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const servers = config.SERVERS;

        const result = {};

        // Host stats (CPU + Memory global usage)
        const hostStats = await dockerService.getDockerStats();
        result.HOST = hostStats;

        for (const server of servers) {
            if (!server.ENABLED) continue;

            // Get cached state
            const stateInfo = monitorsService.getCachedState(server.SERVER_NAME);

            // Get container stats only if running
            let containerStats = { CPU_USAGE: "N/A", MEMORY_USAGE: "N/A" };
            if (stateInfo.state === "running") {
                containerStats = await dockerService.getServerStats(server.SERVER_NAME);
            }

            result[server.SERVER_NAME] = {
                STATUS: {
                    state: stateInfo.state,
                    phase: stateInfo.phase
                },
                PLAYERS: stateInfo.players || 0,
                MAX_PLAYERS: server.MAX_PLAYERS,
                CPU_USAGE: containerStats.CPU_USAGE,
                MEMORY_USAGE: containerStats.MEMORY_USAGE
            };
        }

        res.json(result);
    } catch (err) {
        console.error("❌ Error in getAllServersStatus:", err.message);
        res.status(500).json({ error: "Failed to fetch servers status." });
    }
}


/**
 * Broadcasts server status updates via WebSocket.
 * @param {Object} wss - WebSocket server instance.
 * @param {Array} serversStatus - List of server statuses.
 * @returns {void}
 */
function broadcastServerUpdate(wss, serversStatus) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ event: 'server:update', data: serversStatus }));
        }
    });
}

/*=======================================================================
 *                            EXPORTS
 *======================================================================*/

module.exports = {
    getServers,
    getServerByName,
    addServer,
    updateServer,
    deleteServer,
    startPeriodicCheck,
    getStatus,
    getAllServersStatus,
    startServer,
    stopServer,
    restartServer,
    getAvailableMaps,
};
