const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const dockerService = require("../services/dockerService");
const monitorsService = require("../services/monitorsService");
const cache = require('../utils/cache');

dotenv.config();
const configPath = path.join(__dirname, '../config/config.json');
const availableMaps = process.env.AVAILABLE_MAPS.split(',');

let intervalId = null;
let previousServersStatus = null;

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
        
        console.debug(req.params);
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
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
 * @returns {void} Sends a JSON response confirming deletion or error.
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
            return res.status(404).json({ error: "Server not found - startServer" });
        }

        console.log(server.SERVER_NAME);

        // Start Docker server
        await dockerService.executeStartServer(server.SERVER_NAME);

        // Start Monitoring
        monitorsService.updateMonitoringCache();
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
            return res.status(404).json({ error: "Server not found - restartServer" });
        }

        await dockerService.executeRestartServer(serverName);

        // Start monitoring after Docker restart (3s)
        setTimeout(() => {
            monitorsService.updateMonitoringCache();
            monitorsService.monitorServerState(serverName);
        }, 3000); // 3 secondes par exemple

        

        res.json({ message: `Server ${serverName} is restarting...` });
    } catch (error) {
        console.error(`Error restarting server ${req.params.serverName}:`, error.message);
        res.status(500).json({ error: "Failed to restart server" });
    }
}

// /**
//  * Retrieves the status (ON/OFF) of a specific server.
//  * @param {Object} req - Express request object.
//  * @param {Object} res - Express response object.
//  * @returns {void} Sends a JSON response with server status.
//  */
// async function getStatus(req, res) {
//     const { serverName } = req.params;
//     try {
//         const statusInfo = await dockerService.isServerRunning(serverName);

//         res.json({
//             server: serverName,
//             status: statusInfo.status,
//             details: statusInfo.details
//         });

//     } catch (err) {
//         console.error(`❌ Error fetching status for ${serverName}:`, err.message);
//         res.status(500).json({ error: "Failed to get server status." });
//     }
// }

/**
 * Returns the status and stats of all servers + host stats.
 * @param {Object} req - Express request object.
 * @param {Object} res - Express response object.
*/
async function getAllServersStatus(req, res) {
    try {
        const result = await fetchAllServersStatus();
        //console.debug(result);
        res.json(result);
    } catch (err) {
        console.error("❌ Error in /api/server/status/all:", err.message);
        res.status(500).json({
            message: "Internal server error while fetching server stats."
        });
    }
}

/**
 * Fetches the status and statistics of all servers, including those that are stopped,
 * and merges them with any available runtime stats from the cache.
 *
 * @returns {Promise<Object>} - Returns an object containing:
 *                              - servers: An object with each server's status and stats.
 *                              - hostStats: Host machine stats from cache.
 * @throws {Error} - Throws error if reading the configuration file fails.
 */
async function fetchAllServersStatus() {
    try {
        // Read the full list of servers from config
        const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const allServers = configData.SERVERS;
        const serversWithStats = {};

        allServers.forEach(server => {
            const serverName = server.SERVER_NAME;

            // Retrieve server status from cache (default to running: false if not found)
            const serverStatus = cache.serversStatus[serverName] || { running: false };

            // Retrieve container stats if available
            const containerStat = Object.values(cache.containersStats).find(stat =>
                stat.name.includes(serverName)
            );

            // Merge all data
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
        throw error; // Propagate error to be caught by caller
    }
}

/**
 * Vérifie si le statut a changé depuis la dernière vérification.
 * @param {Object} newStatus - Nouveau statut à vérifier.
 * @returns {boolean} - true si changement détecté, sinon false.
 */
function hasStatusChanged(newStatus) {
    return JSON.stringify(newStatus) !== JSON.stringify(previousServersStatus);
}

/**
 * Lance la vérification périodique (60 sec) des serveurs avec mise à jour conditionnelle via WebSocket.
 * @param {Object} wss - Instance WebSocket Server.
 * @returns {void}
 */
function startPeriodicCheck(wss) {
    if (intervalId) clearInterval(intervalId);

    intervalId = setInterval(async () => {
        await monitorsService.updateMonitoringCache();
        const serversStatus = await fetchAllServersStatus();

        if (hasStatusChanged(serversStatus)) {
            previousServersStatus = serversStatus;
            broadcastServerUpdate(wss, serversStatus);
        }
    }, 60000); // Chaque 60 secondes
}

/**
 * Diffuse immédiatement un événement précis via WebSocket.
 * @param {Object} wss - Instance WebSocket Server.
 * @param {String} event - Type d'événement.
 * @param {Object} data - Données de l'événement.
 * @returns {void}
 */
function broadcastImmediateEvent(wss, event, data) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({ event, data }));
        }
    });
}

/**
 * Diffuse les statuts des serveurs à tous les clients WebSocket.
 * @param {Object} wss - Instance WebSocket Server.
 * @param {Array} serversStatus - Liste des statuts des serveurs.
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
    getAllServersStatus,
    startServer,
    stopServer,
    restartServer,
    getAvailableMaps,
    fetchAllServersStatus
};
