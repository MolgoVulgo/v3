const { spawn } = require("child_process");
const uiService = require("./uiService");
const cache = require('../utils/cache');
const dockerService = require('./dockerService');
const { loadServersConfig } = require('../models/serverModel');

const shooterGameKeywords = require("../config/ShooterGameKeyword.json");
const dockerKeywords = require("../config/dockerKeyword.json");

/*=======================================================================
 *                         MONITORING FUNCTIONS
 *======================================================================*/

let websocketInstance = null;

/**
 * Sets the WebSocket server instance
 * @param {WebSocket.Server} ws
 */
function setWebSocketInstance(ws) {
    websocketInstance = ws;
}

/**
 * Sends immediate event via websocket
 * @param {string} event
 * @param {Object} data
 */
function broadcastImmediateEvent(event, data) {
    if (websocketInstance) {
        websocketInstance.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify({ event, data }));
            }
        });
    }
}

/**
 * Updates the monitoring cache: serversStatus, hostStats, containersStats
 * @returns {Promise<void>}
 */
async function updateMonitoringCache() {
    try {
        const stats = await dockerService.getDockerStats();

        cache.hostStats = {
            CPU_USAGE: stats.CPU_USAGE,
            MEMORY_USAGE: stats.MEMORY_USAGE
        };

        cache.containersStats = stats.containersStats;

        const servers = loadServersConfig();

        for (const server of servers) {
            const status = await dockerService.isServerRunning(server.SERVER_NAME);
            cache.serversStatus[server.SERVER_NAME] = {
                ...server,
                status: status,
                detectedState: status ? 'running' : 'stopped'
            };
        }

    } catch (err) {
        console.error("❌ Failed to update monitoring cache:", err.message);
    }
}

/**
 * Monitors Docker logs and sends keyword state via WebSocket
 * 
 * @param {string} serverId - Server Identifier
 * @param {string} logLine - Log line received
 */
async function monitorDockerLogs(serverId, logLine) {
    for (const keywordObj of dockerKeywords) {
        if (logLine.includes(keywordObj.keyword)) {
            const status = keywordObj.status;

            broadcastImmediateEvent('server:startup', { serverId, status });
            cache.serversStatus[serverId].detectedState = status;
        }
    }
}

/**
 * Monitors ShooterGame logs and sends keyword state via WebSocket
 * 
 * @param {string} serverId - Server Identifier
 * @param {string} logLine - Log line received
 */
async function monitorShooterGameLog(serverId, logLine) {
    for (const keywordObj of shooterGameKeywords) {
        if (logLine.includes(keywordObj.keyword)) {
            const status = keywordObj.status;

            broadcastImmediateEvent('server:startup', { serverId, status });
            cache.serversStatus[serverId].detectedState = status;
        }
    }
}

/**
 * Monitors server state (Docker + ShooterGame logs) and updates UI accordingly.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {void}
 */
function monitorServerState(serverName) {

    cache.serversStatus[serverName].detectedState = "startup";

    dockerService.onDockerLog(serverName, (logLine) => {
        monitorDockerLogs(serverName, logLine);
    });

    dockerService.onShooterGameLog(serverName, (logLine) => {
        monitorShooterGameLog(serverName, logLine);
    });

    setTimeout(() => {
        if (cache.serversStatus[serverName].detectedState === "startup") {
            stopServerDueToFailure(serverName);
        }
    }, 300000); // 5 min timeout
}

/**
 * Stops the server and notifies UI if startup fails.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {void}
 */
function stopServerDueToFailure(serverName) {
    console.log(`[FAILURE] Server ${serverName} failed to start within 5 minutes, stopping...`);
    dockerService.executeStopServer(serverName);
    uiService.notifyUser(`Server ${serverName} failed to start and was stopped automatically.`, "danger");
    cache.serversStatus[serverName].detectedState = "failed";
}

/*=======================================================================
 *                            EXPORTS
 *======================================================================*/

module.exports = { 
    setWebSocketInstance,
    monitorServerState,
    updateMonitoringCache,
    monitorDockerLogs,
    monitorShooterGameLog
};
