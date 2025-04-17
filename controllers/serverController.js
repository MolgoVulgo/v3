/**
 * @fileoverview Controller for handling server management API requests.
 * Interacts with ServerModel for config data and Docker/Monitor services for actions.
 * @version 2.0.0 Refactored to use ServerModel for all config operations.
 */

const serverModel = require('../models/serverModel'); // Utilise le modèle
const dockerService = require("../services/dockerService");
const monitorsService = require("../services/monitorsService");
const rconService = require('../services/rconService');
const cache = require('../utils/cache');
const path = require('path'); // Peut encore être utile pour d'autres chemins

// Charger les variables d'environnement (si nécessaire ici, ex: pour AVAILABLE_MAPS)
require('dotenv').config({ path: path.join(__dirname, '../../.env') }); // Ajuste le chemin vers .env si besoin

const availableMaps = process.env.AVAILABLE_MAPS ? process.env.AVAILABLE_MAPS.split(',') : ['TheIsland']; // Default map

/*=======================================================================
 * CONFIGURATION FUNCTIONS (API Handlers)
 *======================================================================*/

/**
 * GET /api/server - Retrieves all server configurations.
 */
async function getServers(req, res) {
    try {
        const servers = await serverModel.loadServersConfig();
        // On ne renvoie que la liste, pas l'objet complet { SERVERS: [...] }
        res.json(servers);
    } catch (error) {
        console.error("[Controller] Error in getServers:", error);
        res.status(500).json({ error: "Failed to load server configurations." });
    }
}

/**
 * GET /api/server/:serverName - Retrieves a specific server configuration.
 */
async function getServerByName(req, res) {
    try {
        const serverName = req.params.serverName;
        const server = await serverModel.findServerByName(serverName);

        if (!server) {
            return res.status(404).json({ error: `Server "${serverName}" not found.` });
        }
        res.json(server);
    } catch (error) {
        console.error("[Controller] Error in getServerByName:", error);
        res.status(500).json({ error: "Failed to retrieve server configuration." });
    }
}

/**
 * POST /api/server - Adds a new server configuration.
 */
async function addServer(req, res) {
    try {
        // Basic validation (peut être amélioré avec des librairies comme express-validator)
        const requiredFields = ['SERVER_NAME', 'MAP_NAME', 'MAX_PLAYERS'];
        const missingFields = requiredFields.filter(field => !req.body[field]);
        if (missingFields.length > 0) {
            return res.status(400).json({ error: `Missing required fields: ${missingFields.join(', ')}` });
        }

        // Prépare les données, le modèle allouera les ports
        const newServerData = {
            SERVER_NAME: req.body.SERVER_NAME,
            MAP_NAME: req.body.MAP_NAME,
            MAX_PLAYERS: parseInt(req.body.MAX_PLAYERS, 10),
            MODS: req.body.MODS || "", // Default to empty string
            CLUSTER_ID: req.body.CLUSTER_ID, // Le modèle devrait gérer la génération si vide/spécifié
            ENABLED: req.body.ENABLED !== undefined ? Boolean(req.body.ENABLED) : true
        };

         // Génération du Cluster ID si non fourni ou 'new' (peut aussi être fait dans le modèle)
        if (!newServerData.CLUSTER_ID || newServerData.CLUSTER_ID.toLowerCase() === 'new') {
             // Utilise une fonction pour générer l'ID (peut être mise dans utils)
             newServerData.CLUSTER_ID = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                 const r = Math.random() * 16 | 0;
                 return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
            console.log(`[Controller] Generated new Cluster ID: ${newServerData.CLUSTER_ID}`);
        }


        const addedServer = await serverModel.addServerConfig(newServerData);
        res.status(201).json({ message: "Server added successfully.", server: addedServer });

    } catch (error) {
        console.error("[Controller] Error in addServer:", error);
        // Gérer les erreurs spécifiques du modèle (ex: nom dupliqué)
        if (error.message.includes("already exists")) {
            res.status(400).json({ error: error.message });
        } else {
            res.status(500).json({ error: "Failed to add server configuration." });
        }
    }
}

/**
 * PUT /api/server/:serverName - Updates an existing server configuration.
 */
async function updateServer(req, res) {
    try {
        const serverName = req.params.serverName;
        // On ne passe que les champs modifiables au modèle
        const updatableData = {
             // SERVER_NAME, PORT, RCON_PORT ne sont pas modifiables ici
            MAP_NAME: req.body.MAP_NAME,
            MAX_PLAYERS: req.body.MAX_PLAYERS !== undefined ? parseInt(req.body.MAX_PLAYERS, 10) : undefined,
            MODS: req.body.MODS,
            CLUSTER_ID: req.body.CLUSTER_ID,
            ENABLED: req.body.ENABLED !== undefined ? Boolean(req.body.ENABLED) : undefined
        };

        // Retire les champs non définis pour ne pas écraser avec 'undefined'
        Object.keys(updatableData).forEach(key => updatableData[key] === undefined && delete updatableData[key]);

        if (Object.keys(updatableData).length === 0) {
             return res.status(400).json({ error: "No valid fields provided for update." });
        }

        const updatedServer = await serverModel.updateServerConfig(serverName, updatableData);
        res.json({ message: "Server updated successfully.", server: updatedServer });

    } catch (error) {
        console.error("[Controller] Error in updateServer:", error);
        if (error.message.includes("not found")) {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: "Failed to update server configuration." });
        }
    }
}

/**
 * DELETE /api/server/:serverName - Deletes a server configuration.
 */
async function deleteServer(req, res) {
    try {
        const serverName = req.params.serverName;
        // TODO: Ajouter une vérification : ne pas supprimer un serveur qui tourne ?
        // const status = cache.serversStatus[serverName]?.status;
        // if (status && status !== 'off') {
        //     return res.status(400).json({ error: `Cannot delete server "${serverName}" while it is ${status}. Stop it first.` });
        // }

        await serverModel.deleteServerConfig(serverName);
        res.status(200).json({ message: `Server "${serverName}" deleted successfully.` }); // Status 200 ou 204 (No Content)

    } catch (error) {
        console.error("[Controller] Error in deleteServer:", error);
        if (error.message.includes("not found")) {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: "Failed to delete server configuration." });
        }
    }
}

/**
 * GET /api/maps - Retrieves the list of available maps from environment variable.
 */
function getAvailableMaps(req, res) {
    // Assure une valeur par défaut si la variable d'environnement n'est pas définie
    res.json(availableMaps);
}


/*=======================================================================
 * DOCKER & MONITOR FUNCTIONS (API Handlers)
 *======================================================================*/

/**
 * POST /api/server/:serverName/action/start - Starts a server container.
 */
async function startServer(req, res) {
    const serverName = req.params.serverName;
    try {
        // Vérifie si le serveur existe dans la config avant de le démarrer
        const server = await serverModel.findServerByName(serverName);
        if (!server) {
            return res.status(404).json({ error: `Server "${serverName}" configuration not found.` });
        }
        if (!server.ENABLED) {
             return res.status(400).json({ error: `Server "${serverName}" is disabled in configuration.` });
        }

        console.log(`[Controller][START] Request received for server ${serverName}`);

        // Lance le démarrage via dockerService (qui utilise maintenant dockerode)
        await dockerService.executeStartServer(serverName); // executeStartServer contient déjà findServerByName, redondant? Non, car on check ENABLED ici.

        // Le monitoring est maintenant lancé par dockerService/monitorsService
        // mais on peut déclencher une mise à jour immédiate du statut via WS ici si besoin,
        // bien que monitorsService devrait le faire.
        // monitorsService.updateAndNotifyStatus(serverName, "startup"); // Déjà fait au début de monitorServerState

        // Lance le stream de stats si pas déjà fait (normalement initMonitoring s'en charge si déjà up)
        // Peut-être forcer le démarrage du stream ici ?
        const containerId = `ARK-ASA-${serverName}`; // Nommage conventionnel
        // On ne lance pas le stream d'ici, initMonitoring et monitorServerState devraient gérer

        res.json({ message: `Server ${serverName} start initiated.` }); // Réponse immédiate

    } catch (error) {
        console.error(`❌ [Controller] Error starting server ${serverName}:`, error);
        // Peut renvoyer une erreur plus spécifique si dockerService en lève une
        res.status(500).json({ error: `Failed to start server ${serverName}: ${error.message}` });
    }
}

/**
 * POST /api/server/:serverName/action/stop - Stops a server container.
 */
async function stopServer(req, res) {
    const serverName = req.params.serverName;
    try {
        console.log(`[Controller][STOP] Request received for server ${serverName}`);
        // Pas besoin de vérifier la config pour arrêter, dockerService gérera le "not found"
        await dockerService.executeStopServer(serverName);

        // S'assure que le statut est mis à jour dans le cache et broadcasté
        // (même si dockerService peut déjà le faire via des events futurs)
        monitorsService.updateAndNotifyStatus(serverName, "off");

        res.status(200).json({ message: `Server ${serverName} stop initiated.` });

    } catch (error) {
        console.error(`❌ [Controller] Error stopping server ${serverName}:`, error);
        res.status(500).json({ error: `Failed to stop server ${serverName}: ${error.message}` });
    }
}

/**
 * POST /api/server/:serverName/action/restart - Restarts a server container.
 */
async function restartServer(req, res) {
    const serverName = req.params.serverName;
    try {
         // Vérifie si le serveur existe dans la config avant de le redémarrer
         const server = await serverModel.findServerByName(serverName);
         if (!server) {
             return res.status(404).json({ error: `Server "${serverName}" configuration not found.` });
         }
         // Pourrait aussi vérifier s'il est enabled

        console.log(`[Controller][RESTART] Request received for server ${serverName}`);
        await dockerService.executeRestartServer(serverName); // Utilise la fonction restart de dockerode

        // Déclenche la séquence de monitoring comme pour un démarrage normal
        monitorsService.updateAndNotifyStatus(serverName, "startup");
        // Relance la surveillance d'état complète
        monitorsService.monitorServerState(serverName); // Assure que le monitor redémarre

        res.json({ message: `Server ${serverName} restart initiated.` });

    } catch (error) {
        console.error(`❌ [Controller] Error restarting server ${serverName}:`, error);
        res.status(500).json({ error: `Failed to restart server ${serverName}: ${error.message}` });
    }
}

/*=======================================================================
 * STATUS & MONITORING FUNCTIONS
 *======================================================================*/

/**
 * Fetches combined static config and dynamic status for all servers.
 * Used by frontend and potentially monitoring routes.
 * @returns {Promise<{servers: object, hostStats: object}>}
 * @throws {Error} If config reading fails.
 */
async function fetchAllServersStatus() {
    console.debug("[Controller] Fetching all servers status (RCON Liveness Check Priority)...");
    try {
        const configServers = await serverModel.loadServersConfig();
        const serversWithStats = {};
        const hostStats = cache.hostStats || { CPU_USAGE: "N/A", MEMORY_USAGE: "N/A" };

        const statusPromises = configServers.map(async (server) => {
            const serverName = server.SERVER_NAME;

            // 1. Récupérer l'état mis en cache par le monitoring
            const cachedServerStatus = cache.serversStatus[serverName];
            const cachedStatus = cachedServerStatus?.status || 'off';

            // 2. Effectuer la vérification de vivacité via RCON
            // getPlayersCount retourne un nombre (>=0) si succès, null si échec.
            const playerCountResult = await rconService.getPlayersCount(serverName);
            const isRconResponding = (playerCountResult !== null);

            // 3. Déterminer le statut à afficher pour le chargement de page
            let displayStatus;

            // Priorité 1: L'état d'erreur connu par le monitoring est prioritaire
            if (cachedStatus === 'error') {
                displayStatus = 'error';
            }
            // Priorité 2: Si RCON répond, le serveur est fonctionnel -> 'running'
            else if (isRconResponding) {
                displayStatus = 'running';
            }
            // Priorité 3: Si RCON ne répond pas MAIS le monitoring est en 'startup', on affiche 'startup'
            else if (cachedStatus === 'startup') {
                displayStatus = 'startup';
            }
            // Priorité 4: Si RCON ne répond pas et que le cache n'indique rien de spécial ('off' ou inconnu), on affiche 'off'
            else {
                displayStatus = 'off';
            }

            // 4. Récupérer les stats du cache
            const containerStats = cache.containersStats[serverName];
            const cpuUsage = containerStats?.CPU_USAGE ?? "N/A";
            const memoryUsage = containerStats?.MEMORY_USAGE ?? "N/A";

            // 5. Construire l'objet final
            serversWithStats[serverName] = {
                ...server,
                status: displayStatus, // Le statut réconcilié
                detectedState: cachedServerStatus?.detectedState || displayStatus,
                CPU_USAGE: cpuUsage,
                MEMORY_USAGE: memoryUsage,
                // Ajoute le nombre de joueurs si disponible
                PLAYER_COUNT: isRconResponding ? playerCountResult : 'N/A'
            };
        });

        await Promise.all(statusPromises);
        return { servers: serversWithStats, hostStats };

    } catch (error) {
        console.error("❌ Error in fetchAllServersStatus (RCON Liveness):", error);
        // En cas d'erreur majeure ici (ex: lecture configServer.json), il faut la gérer
        throw error; // ou retourner un état d'erreur pour l'ensemble de la page ?
    }
}

/**
 * API Handler for GET /api/monitoring/status - Returns status for all servers.
 */
async function getAllServersStatus(req, res) {
    try {
        const result = await fetchAllServersStatus();
        res.json(result);
    } catch (err) {
        console.error("❌ Error in API /api/monitoring/status:", err);
        res.status(500).json({
            error: "Internal server error while fetching server statuses."
        });
    }
}

/**
 * Broadcasts server updates (status, stats) to all connected WebSocket clients.
 * @param {WebSocketServer} wss - The WebSocket Server instance.
 * @param {object} serversStatusData - The data object from fetchAllServersStatus ({servers, hostStats}).
 */
function broadcastServerUpdate(wss, serversStatusData) {
     if (!wss || !serversStatusData) {
         console.warn("[Controller] Cannot broadcast update: WSS or data missing.");
         return;
     }
     const { servers, hostStats } = serversStatusData;

     // Broadcast individual server statuses/stats
     if (servers) {
         Object.keys(servers).forEach(serverName => {
             const server = servers[serverName];
             const payload = {
                 type: "monitoring", // Utilise le type défini dans monitorsService/frontend
                 scope: "server",
                 target: serverName,
                 event: "status", // Ou un event 'full_update' ? Gardons 'status' pour l'instant
                 data: { // Ne renvoyer que les données dynamiques pertinentes ? Ou tout ?
                     status: server.status,
                     CPU_USAGE: server.CPU_USAGE,
                     MEMORY_USAGE: server.MEMORY_USAGE,
                     detectedState: server.detectedState
                     // Ajouter d'autres champs si nécessaire (ex: player count si dispo)
                 }
             };
             // Utilise la fonction centralisée pour broadcaster
             monitorsService.broadcastImmediateEvent(payload);
         });
     } else {
         console.warn("[Controller] No server data to broadcast.");
     }

     // Broadcast host stats
     if (hostStats) {
         const hostPayload = {
             type: "monitoring",
             scope: "host",
             target: "host",
             event: "stats",
             data: hostStats
         };
         monitorsService.broadcastImmediateEvent(hostPayload);
     } else {
         console.warn("[Controller] No host stats data to broadcast.");
     }
     console.debug("[Controller] Broadcast update sent via monitorsService.");
}


/*=======================================================================
 * EXPORTS
 *======================================================================*/

module.exports = {
    // Config CRUD
    getServers,
    getServerByName,
    addServer,
    updateServer,
    deleteServer,
    // Maps
    getAvailableMaps,
    // Actions
    startServer,
    stopServer,
    restartServer,
    // Status / Monitoring API
    getAllServersStatus, // Handler pour la route API
    // Fonctions utilisées par d'autres modules/routes
    fetchAllServersStatus, // Utilisé par index.js route '/' et getAllServersStatus
    broadcastServerUpdate // Utilisé par index.js pour le broadcast initial
};