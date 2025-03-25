const os = require('os'); // Assure-toi que 'os' est bien importé en haut
const cache = require('../utils/cache');
const dockerService = require('./dockerService');
const { loadServersConfig } = require('../models/serverModel');

const shooterGameKeywords = require("../config/ShooterGameKeyword.json");
const dockerKeywords = require("../config/dockerKeyword.json");

let websocketInstance = null;

/**
 * Sets the WebSocket server instance
 */
function setWebSocketInstance(ws) {
    websocketInstance = ws;
}

/**
 * Broadcasts immediate WebSocket message with unified format.
 */
function broadcastImmediateEvent(eventObject) {
    if (websocketInstance) {
        websocketInstance.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify(eventObject));
            }
        });
    }
}

/**
 * Updates monitoring cache for server config only
 */
async function updateMonitoringCache() {
    try {
        const servers = loadServersConfig();

        for (const server of servers) {
            const serverName = server.SERVER_NAME;

            // Remplir systématiquement le cache avec des valeurs par défaut
            cache.serversStatus[serverName] = {
                ...server,
                status: 'off',
                detectedState: 'off',
                CPU_USAGE: "N/A",
                MEMORY_USAGE: "N/A"
            };
        }

        // Initialiser les stats host même si aucun container actif
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        cache.hostStats = {
            CPU_USAGE: "N/A",
            MEMORY_USAGE: {
                used: usedMem,
                total: totalMem
            }
        };

    } catch (err) {
        console.error("❌ Failed to update monitoring cache:", err.message);
    }
}

/**
 * Monitors Docker logs and sends keyword state via WebSocket
 */
async function monitorDockerLogs(serverId, logLine) {
    for (const keywordObj of dockerKeywords) {
        if (logLine.includes(keywordObj.keyword)) {
            broadcastImmediateEvent({
                type: "monitoring",
                scope: "server",
                target: serverId,
                event: "log",
                data: { message: keywordObj.status, timestamp: Date.now() }
            });
        }
    }
}

/**
 * Monitors ShooterGame logs and sends keyword state via WebSocket
 */
async function monitorShooterGameLog(serverId, logLine) {
    for (const keywordObj of shooterGameKeywords) {
        if (logLine.includes(keywordObj.keyword)) {
            broadcastImmediateEvent({
                type: "monitoring",
                scope: "server",
                target: serverId,
                event: "log",
                data: { message: keywordObj.status, timestamp: Date.now() }
            });
        }
    }
}

/**
 * Monitors server state and handles timeout failure.
 */
function monitorServerState(serverName) {
    monitorDockerLogs(serverName);
    monitorShooterGameLog(serverName);

    // Timeout auto-stop if stuck
    setTimeout(() => {
        dockerService.executeStopServer(serverName);
    }, 300000); // 5min timeout
}

module.exports = { 
    setWebSocketInstance,
    monitorServerState,
    updateMonitoringCache,
    monitorDockerLogs,
    monitorShooterGameLog
};
