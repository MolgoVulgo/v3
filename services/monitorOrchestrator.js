const cache = require('../utils/cache');

let websocketInstance = null;

/**
 * Associe l'instance WebSocket globale au module.
 * @param {*} ws 
 */
function setWebSocketInstance(ws) {
    websocketInstance = ws;
}

/**
 * Envoie un événement immédiat aux clients WebSocket.
 * @param {*} eventObject 
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
 * Met à jour les stats d’un serveur dans le cache.
 * @param {string} serverName 
 * @param {object} updates 
 */
function setServerStatus(serverName, updates = {}) {
    if (!cache.serversStatus[serverName]) {
        cache.serversStatus[serverName] = {
            SERVER_NAME: serverName,
            status: 'off',
            detectedState: 'off',
            CPU_USAGE: 'N/A',
            MEMORY_USAGE: 'N/A'
        };
    }

    cache.serversStatus[serverName] = {
        ...cache.serversStatus[serverName],
        ...updates
    };
}

/**
 * Met à jour les stats de la machine hôte.
 * @param {object} stats 
 */
function setHostStats(stats = {}) {
    cache.hostStats = {
        ...cache.hostStats,
        ...stats
    };
}

/**
 * Met à jour le statut d’un serveur + broadcast WS.
 * @param {string} serverName 
 * @param {string} status 
 * @param {object} extra 
 */
function updateAndNotifyStatus(serverName, status, extra = {}) {
    const statsFromCache = cache.containersStats[serverName] || {};

    const payload = {
        status,
        detectedState: status,
        CPU_USAGE: statsFromCache.CPU_USAGE ?? "N/A",
        MEMORY_USAGE: statsFromCache.MEMORY_USAGE ?? "N/A",
        ...extra
    };

    setServerStatus(serverName, payload);

    broadcastImmediateEvent({
        type: "monitoring",
        scope: "server",
        target: serverName,
        event: "status",
        data: payload
    });
}

module.exports = {
    setWebSocketInstance,
    broadcastImmediateEvent,
    setServerStatus,
    setHostStats,
    updateAndNotifyStatus
};
