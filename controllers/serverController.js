const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const dockerService = require("../services/dockerService");
const monitorsService = require("../services/monitorsService");
const cache = require('../utils/cache');

dotenv.config();
const configPath = path.join(__dirname, '../config/config.json');
const availableMaps = process.env.AVAILABLE_MAPS.split(',');

/*=======================================================================
 *                         CONFIGURATION FUNCTIONS
 *======================================================================*/

/**
 * Retrieves the server configuration by its name.
 */
function getServerConfig(serverName) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return config.SERVERS.find(s => s.SERVER_NAME === serverName) || null;
}

/**
 * Retrieves the list of all servers.
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
 * Retrieves a specific server by its name.
 */
function getServerByName(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const server = config.SERVERS.find(s => s.SERVER_NAME === req.params.serverName);

        if (!server) {
            return res.status(404).json({ error: "Server not found - getServerByName" });
        }

        res.json(server);
    } catch (error) {
        console.error("Error fetching server:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Adds a new server with validation.
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
 */
function updateServer(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const serverIndex = config.SERVERS.findIndex(s => s.SERVER_NAME === req.params.serverName);

        if (serverIndex === -1) {
            return res.status(404).json({ error: "Server not found - updateServer" });
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
 */
function deleteServer(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const serverName = req.params.serverName;

        if (!config.SERVERS.some(server => server.SERVER_NAME === serverName)) {
            return res.status(404).json({ error: "Server not found - deleteServer" });
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
 */
function getAvailableMaps(req, res) {
    res.json(availableMaps);
}

/*=======================================================================
 *                           DOCKER & MONITOR FUNCTIONS
 *======================================================================*/

/**
 * Starts a specific Ark ASA server and triggers monitoring.
 */
async function startServer(req, res) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const server = config.SERVERS.find(s => s.SERVER_NAME === req.params.serverName);

        if (!server) {
            return res.status(404).json({ error: "Server not found - startServer" });
        }

        await dockerService.executeStartServer(server.SERVER_NAME);
        monitorsService.monitorServerState(server.SERVER_NAME);

        res.json({ message: `Server ${server.SERVER_NAME} is starting.` });
    } catch (error) {
        console.error("Error starting server:", error);
        res.status(500).json({ error: "Failed to start server" });
    }
}

/**
 * Stops an Ark ASA server.
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
 */
async function restartServer(req, res) {
    try {
        const serverName = req.params.serverName;
        const server = getServerConfig(serverName);

        if (!server) {
            return res.status(404).json({ error: "Server not found - restartServer" });
        }

        await dockerService.executeRestartServer(serverName);
        monitorsService.monitorServerState(serverName);

        res.json({ message: `Server ${serverName} is restarting...` });
    } catch (error) {
        console.error(`Error restarting server ${req.params.serverName}:`, error.message);
        res.status(500).json({ error: "Failed to restart server" });
    }
}

/**
 * Returns the status and stats of all servers + host stats.
 */
async function getAllServersStatus(req, res) {
    try {
        const result = await fetchAllServersStatus();
        res.json(result);
    } catch (err) {
        console.error("❌ Error in /api/server/status/all:", err.message);
        res.status(500).json({
            message: "Internal server error while fetching server stats."
        });
    }
}

/**
 * Fetches the status and statistics of all servers, including stopped ones,
 * merging them with runtime stats from the cache.
 */
async function fetchAllServersStatus() {
    try {
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const allServers = configData.SERVERS;
        const serversWithStats = {};

        allServers.forEach(server => {
            const serverName = server.SERVER_NAME;
            const serverStatus = cache.serversStatus[serverName] || { running: false };
            const containerStat = cache.containersStats[serverName];

            serversWithStats[serverName] = {
                ...serverStatus,
                CPU_USAGE: containerStat ? containerStat.CPU_USAGE : "N/A",
                MEMORY_USAGE: containerStat ? containerStat.MEMORY_USAGE : "N/A"
            };
        });

        return {
            servers: serversWithStats,
            hostStats: cache.hostStats
        };
    } catch (error) {
        console.error("❌ Error in fetchAllServersStatus:", error.message);
        throw error;
    }
}

/**
 * Broadcasts servers' statuses and host stats to all WebSocket clients.
 */
function broadcastServerUpdate(wss, serversStatus) {
    Object.keys(serversStatus.servers).forEach(serverName => {
        const server = serversStatus.servers[serverName];

        wss.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({
                    type: "monitoring",
                    scope: "server",
                    target: serverName,
                    event: "status",
                    data: {
                        status: server.status,
                        CPU_USAGE: server.CPU_USAGE,
                        MEMORY_USAGE: server.MEMORY_USAGE,
                        detectedState: server.detectedState
                    }
                }));
            }
        });
    });

    // Send host stats
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                type: "monitoring",
                scope: "host",
                target: "host",
                event: "stats",
                data: serversStatus.hostStats
            }));
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
    getAllServersStatus,
    startServer,
    stopServer,
    restartServer,
    getAvailableMaps,
    fetchAllServersStatus,
    broadcastServerUpdate
};
