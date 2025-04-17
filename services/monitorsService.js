/**
 * @fileoverview Service for monitoring server status, logs, and stats.
 * Consumes data streams from dockerService and manages cache/WebSocket updates.
 * @version 2.0.0 Refactored for circular dependency fix
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Readable } = require('stream'); // Keep for ShooterGame log monitoring

// Local Dependencies
const cache = require('../utils/cache');
const dockerService = require('./dockerService'); // Depends on the updated dockerService
const serverModel = require('../models/serverModel');
const shooterGameKeywords = require("../config/ShooterGameKeyword.json");
const dockerKeywords = require("../config/dockerKeyword.json");

let websocketInstance = null;
let hostStatsMonitorActive = false;
const activeStatStreams = {}; // Keep track of active stat stream consumers

/**
 * Sets the global WebSocket server instance.
 * @param {WebSocket.Server} ws - The WebSocket server instance.
 */
function setWebSocketInstance(ws) {
    console.log("[Monitor] WebSocket instance set.");
    websocketInstance = ws;
    // Pass it to dockerService as well, although it might not use it directly anymore
    dockerService.setWebSocketInstance(ws);
}

/**
 * Broadcasts an event object to all connected WebSocket clients immediately.
 * @param {object} eventObject - The event object to broadcast.
 */
function broadcastImmediateEvent(eventObject) {
    if (websocketInstance) {
        websocketInstance.clients.forEach(client => {
            // Check if the client is ready
            if (client.readyState === 1 /* WebSocket.OPEN */) {
                client.send(JSON.stringify(eventObject));
            }
        });
    } else {
        // console.warn("[Monitor] Cannot broadcast: WebSocket instance not set.");
    }
}

/**
 * Updates the status cache for a specific server.
 * Creates the entry if it doesn't exist.
 * @param {string} serverName - The name of the server.
 * @param {object} updates - An object containing properties to update.
 */
function setServerStatus(serverName, updates = {}) {
    if (!cache.serversStatus[serverName]) {
        console.debug(`[Cache] Initializing status cache for ${serverName}.`);
        cache.serversStatus[serverName] = {
            SERVER_NAME: serverName,
            status: 'off',
            detectedState: 'off',
            CPU_USAGE: 'N/A', // Keep 'N/A' until first stats arrive
            MEMORY_USAGE: 'N/A', // Keep 'N/A' until first stats arrive
            initialStatsSent: false // Flag for initial status broadcast logic
        };
    }

    // Merge updates into existing status
    cache.serversStatus[serverName] = {
        ...cache.serversStatus[serverName],
        ...updates
    };
    // console.debug(`[Cache] Updated status for ${serverName}:`, cache.serversStatus[serverName]);
}

/**
 * Updates the host stats in the cache.
 * @param {object} stats - Object containing host stats (CPU_USAGE, MEMORY_USAGE).
 */
function setHostStats(stats = {}) {
    cache.hostStats = {
        ...cache.hostStats,
        ...stats
    };
     // console.debug("[Cache] Updated host stats:", cache.hostStats);
}

/**
 * Updates the server status cache and broadcasts the new status via WebSocket.
 * This is the primary function to call when a server's high-level status changes.
 * It now ensures stats from cache are included if available.
 * @param {string} serverName - The name of the server.
 * @param {string} status - The new status (e.g., "startup", "running", "off", "error").
 * @param {object} [extraData={}] - Optional additional data to include in the broadcast.
 */
function updateAndNotifyStatus(serverName, status, extraData = {}) {
    console.log(`[Monitor] Updating status for ${serverName} to: ${status}`);
    const containerStats = cache.containersStats[serverName]; // Get current stats if available

    const statusUpdate = {
        status: status,
        detectedState: status, // Assuming status reflects detected state for now
        CPU_USAGE: containerStats?.CPU_USAGE ?? 'N/A', // Use cached stats if present
        MEMORY_USAGE: containerStats?.MEMORY_USAGE ?? 'N/A', // Use cached stats if present
        ...extraData // Allow overriding with specific data if needed
    };

    // Update the central server status cache
    setServerStatus(serverName, statusUpdate);

    // Broadcast the update
    broadcastImmediateEvent({
        type: "monitoring",
        scope: "server", // Event scope is the server's overall status
        target: serverName,
        event: "status", // Event type is a status change
        data: cache.serversStatus[serverName] // Send the complete, updated server status object
    });
}


/**
 * Consumes a stats stream from dockerService, updates cache, and broadcasts stats.
 * @param {ReadableStream} statsStream - The object stream returned by dockerService.streamContainerStats.
 */
function consumeStatsStream(statsStream) {
    let serverName = 'unknown'; // Will be updated on first data chunk

    statsStream.on('data', (statsData) => {
        if (statsData.type === 'stats') {
            serverName = statsData.serverName; // Update serverName context
            // console.debug(`[Monitor][Stats Data][${serverName}]`, statsData);

            // 1. Update container stats cache
            cache.containersStats[serverName] = {
                name: serverName,
                CPU_USAGE: statsData.cpu,
                MEMORY_USAGE: statsData.memory
            };
             // console.debug(`[Cache][${serverName}] Container stats updated:`, cache.containersStats[serverName]);

            // 2. Broadcast container stats
            broadcastImmediateEvent({
                type: "monitoring",
                scope: "container", // Specific scope for detailed stats
                target: serverName,
                event: "stats",
                data: cache.containersStats[serverName]
            });

            // 3. Check if this triggers the 'running' state confirmation
            const serverStatus = cache.serversStatus[serverName];
            if (serverStatus && (serverStatus.status === 'startup' || serverStatus.status === 'running') && !serverStatus.initialStatsSent) {
                 console.log(`[Monitor][${serverName}] First stats received, confirming 'running' state.`);
                 // Mark that initial stats have been processed for status logic
                 setServerStatus(serverName, { initialStatsSent: true });
                 // Ensure the main status broadcast reflects 'running' with current stats
                 updateAndNotifyStatus(serverName, 'running');
            }
        }
    });

    statsStream.on('error', (err) => {
        console.error(`❌ [Monitor][Stats Stream Err][${serverName}] Error consuming stats stream:`, err.message);
        // Clean up cache for this server's stats on error
        delete cache.containersStats[serverName];
        // Maybe notify status as 'error' or 'unknown'?
        updateAndNotifyStatus(serverName, 'unknown', { error: 'Stats stream failed' });
        // Remove from active streams tracker
        if (statsData.containerId) delete activeStatStreams[statsData.containerId];

    });

    statsStream.on('end', () => {
        console.log(`[Monitor][Stats Stream End][${serverName}] Stats stream ended.`);
        // Decide policy: clear stats on end, or keep last known? Keeping last known for now.
        // delete cache.containersStats[serverName];
        // Reset the initial stats flag for the next potential start
        if (cache.serversStatus[serverName]) {
            setServerStatus(serverName, { initialStatsSent: false });
        }
         // Remove from active streams tracker
         if (statsData.containerId) delete activeStatStreams[statsData.containerId];
    });
}

/**
 * Monitors host CPU and Memory usage independently and periodically.
 * Updates cache and broadcasts host stats.
 */
async function monitorHostStats() {
    if (hostStatsMonitorActive) {
        console.warn("[Monitor] Host stats monitor already active.");
        return;
    }
    console.log("[Monitor] Starting independent host stats monitoring...");
    hostStatsMonitorActive = true;
    let previousCpuTimes = os.cpus().map(cpu => cpu.times);

    // Use a function for the interval logic for clarity
    const updateAndBroadcastHostStats = () => {
        try {
            // --- CPU Calculation ---
            const currentCpus = os.cpus();
            let totalIdleDiff = 0;
            let totalTickDiff = 0;

            currentCpus.forEach((cpu, i) => {
                 const prevTimes = previousCpuTimes[i] || { idle: 0, user: 0, nice: 0, sys: 0, irq: 0 }; // Handle potential new CPU cores? Unlikely.
                 const currentTimes = cpu.times;
                 const idleDifference = currentTimes.idle - prevTimes.idle;
                 let tickDifference = 0;
                 // Calculate total ticks difference for this CPU core
                 for (const type in currentTimes) {
                    tickDifference += (currentTimes[type] - (prevTimes[type] || 0));
                 }

                 // Add this core's difference to the total difference
                 if (tickDifference > 0) { // Avoid division by zero or negative time travel
                    totalIdleDiff += idleDifference;
                    totalTickDiff += tickDifference;
                 }
            });
             previousCpuTimes = currentCpus.map(cpu => cpu.times); // Update for next interval

             // Calculate overall CPU usage percentage
             const cpuUsagePercent = totalTickDiff > 0 ? (1.0 - totalIdleDiff / totalTickDiff) * 100.0 : 0.0;

             // --- Memory Calculation ---
             const totalMem = os.totalmem(); // Total system memory in bytes
             const freeMem = os.freemem(); // Free system memory in bytes
             const usedMem = totalMem - freeMem; // Used system memory in bytes

             // --- Update Cache ---
             const hostStatsData = {
                 CPU_USAGE: parseFloat(cpuUsagePercent.toFixed(1)), // Keep as number, 1 decimal place
                 MEMORY_USAGE: {
                     used: usedMem, // Bytes
                     total: totalMem // Bytes
                 }
             };
             setHostStats(hostStatsData); // Update cache.hostStats

             // --- Broadcast Host Stats ---
             broadcastImmediateEvent({
                 type: 'monitoring',
                 scope: 'host',
                 target: 'host',
                 event: 'stats',
                 data: hostStatsData,
             });
        } catch (error) {
            console.error("❌ Error during host stats update:", error);
            // Avoid crashing the monitor loop
        }
    };

    // Run immediately once, then set interval
    updateAndBroadcastHostStats();
    setInterval(updateAndBroadcastHostStats, 5000); // Update every 5 seconds
}


/**
 * Initializes the monitoring service.
 * - Sets initial cache state based on config.
 * - Starts stats streaming for already running containers.
 * - Starts independent host monitoring.
 */
async function initMonitoring() {
    console.log("🔄 Initializing Monitoring Service...");

    // 1. Initialize cache with server data from config
    try {
        const servers = await serverModel.loadServersConfig(); // Attend le résultat

        if (Array.isArray(servers)) {
            servers.forEach(server => {
                setServerStatus(server.SERVER_NAME, { ...server });
            });
            console.log(`[Monitor] Initialized cache for ${servers.length} servers from config.`);
        } else {
             console.error("❌ Failed to initialize server cache: loadServersConfig did not return an array.", servers);
             // Peut-être initialiser avec un tableau vide ?
             // servers = []; // Optionnel: continuer avec une liste vide
        }
    } catch (err) { // Catch pour l'étape 1
        console.error("❌ Failed to initialize server cache from config:", err.message);
        // Selon la gravité, on pourrait vouloir arrêter ici ou continuer
    }

    // 2. Start stats streaming for containers detected as running
    try { // Début du deuxième try
        console.log("[Monitor] Starting initial stats stream consumption...");
        const streams = await dockerService.startStatsStreamingForAllContainers(); // Peut échouer

        if (streams && streams.length > 0) {
             console.log(`[Monitor] Consuming initial stats streams for ${streams.length} containers.`);
             streams.forEach(stream => {
                 // La fonction consumeStatsStream a ses propres try/catch internes pour la gestion du stream lui-même
                 consumeStatsStream(stream);
             });
        } else {
            console.log("[Monitor] No active container streams found to consume initially.");
        }
    } catch (err) { // ===> Catch pour l'étape 2 (manquant précédemment) <===
        console.error("❌ Error during initial stats stream processing:", err.message, err.stack);
        // Il est probablement judicieux de logguer l'erreur mais de laisser le monitoring continuer (pour l'hôte, etc.)
    } // Fin du deuxième try...catch

    // 3. Start independent host monitoring if not already started
    try { // Ajout d'un try/catch ici aussi par sécurité
        if (!hostStatsMonitorActive) {
            monitorHostStats(); // Lance la boucle de surveillance de l'hôte
        }
    } catch(err) {
        console.error("❌ Error starting host stats monitor:", err.message, err.stack);
    }


    console.log("✅ Monitoring Service Initialized (potentially with errors during sub-tasks).");
}

// --- monitorDockerLogs reste quasi identique ---
async function monitorDockerLogs(serverName, containerName) {
    return new Promise(async (resolve, reject) => {
        try {
            console.debug(`[Monitor][Docker Logs] Starting surveillance for ${serverName} (${containerName})`);
            const logStream = await dockerService.streamDockerLogs(containerName);

            const rl = readline.createInterface({
                input: logStream,
                crlfDelay: Infinity
            });

            const detected = new Set();
            const finalKeyword = "wine: RLIMIT_NICE is <= 20, unable to use setpriority safely";
            let finalKeywordFound = false;

            rl.on('line', (logLine) => {
                // Si l'interface est déjà fermée (peut arriver si plusieurs lignes arrivent vite), ne rien faire
                if (rl.closed) return;

                // console.debug(`[monitorDockerLogs][${serverName}] LINE: ${logLine}`); // Garder pour débogage si besoin

                for (const { keyword, state } of dockerKeywords) {
                    if (logLine.includes(keyword) && !detected.has(state)) {
                        detected.add(state);
                        // console.log(`[monitorDockerLogs][${serverName}] MATCHED KEYWORD: "${keyword}" -> State: "${state}"`); // Garder pour débogage si besoin

                        // Broadcast log event for UI feedback
                        broadcastImmediateEvent({
                            type: "monitoring",
                            scope: "server",
                            target: serverName,
                            event: "log",
                            data: { message: state, timestamp: Date.now(), source: "docker" }
                        });

                        if (keyword === finalKeyword) {
                            finalKeywordFound = true;
                            console.log(`[Monitor][Docker Logs][${serverName}] Final keyword detected. Closing Docker log monitoring for this phase.`);
                            // ====> LA CORRECTION <====
                            // Ferme l'interface readline. Cela arrêtera de lire les lignes
                            // et déclenchera l'événement 'close' ci-dessous.
                            rl.close();
                            // Sort de la boucle 'for' et de l'événement 'line' pour cette ligne,
                            // car on a trouvé ce qu'on cherchait et on ferme.
                            return;
                        }
                    }
                }
            });

            rl.on('close', () => {
                console.log(`[Monitor][Docker Logs][${serverName}] Readline interface closed.`);
                // On résout la promesse quand l'interface est fermée.
                // On peut vérifier si c'est parce qu'on a trouvé le mot clé final.
                if (!finalKeywordFound) {
                    console.warn(`[Monitor][Docker Logs][${serverName}] Stream closed/ended BEFORE final Docker keyword was detected. Proceeding anyway.`);
                    // Décision : on résout quand même pour ne pas bloquer, mais avec un avertissement.
                    // Si ce cas pose problème, on pourrait rejeter la promesse ici : reject(new Error('Docker logs ended prematurely'));
                }
                resolve(); // Résout la promesse pour que monitorServerState continue
            });

            rl.on('error', (err) => {
                console.error(`❌ [Monitor][Docker Logs][${serverName}] Error reading log stream:`, err.message);
                reject(err); // Rejette la promesse en cas d'erreur de lecture
            });

            // Optionnel : Ajouter un timeout global au cas où même le mot clé final n'arrive jamais ?
            // const timeoutHandle = setTimeout(() => {
            //    if (!rl.closed) {
            //        console.warn(`[Monitor][Docker Logs][${serverName}] Monitoring timeout reached. Closing and resolving.`);
            //        rl.close(); // Tentera de résoudre via le handler 'close'
            //    }
            // }, 300000); // Ex: Timeout de 5 minutes

            // Assurer que le timeout est nettoyé si la promesse se termine avant
            // ?? Comment faire ça proprement avec la structure Promise ?? -> Peut-être déplacer hors du constructeur Promise.
            // Pour l'instant, on laisse sans timeout global pour simplifier.

        } catch (err) { // Erreur lors de l'obtention du stream initial
            console.error(`❌ [Monitor][Docker Logs][${serverName}] Failed to start Docker log monitoring:`, err);
            reject(err);
        }
    });
}

// --- monitorShooterGameLog reste quasi identique ---
async function monitorShooterGameLog(serverName) {
     // ... (même code que dans ta version précédente) ...
      return new Promise((resolve, reject) => {
        // Construct the expected path to the log file
        // IMPORTANT: Ensure this path is correct relative to where your Node app runs
        const logPath = path.join(__dirname, "..", "server-files", serverName, "ShooterGame", "Saved", "Logs", "ShooterGame.log");
        console.debug(`[Monitor][ShooterGame Log][${serverName}] Attempting to monitor log file at: ${logPath}`);

        // Check if the log file exists before attempting to read
        if (!fs.existsSync(logPath)) {
            console.warn(`[Monitor][ShooterGame Log][${serverName}] Log file not found at expected path: ${logPath}. Skipping monitoring.`);
            // Resolve peacefully - maybe the server hasn't created it yet.
            // The calling function (monitorServerState) should handle this.
            return resolve();
            // Or reject if this is considered a fatal error for the monitoring step:
            // return reject(new Error(`ShooterGame log file not found: ${logPath}`));
        }

        // Use fs.watch or a more robust library like 'chokidar' for real-time monitoring?
        // For now, reading the file content once or periodically might be simpler.
        // Let's stick to createReadStream for initial detection phase as per original logic.
        const stream = fs.createReadStream(logPath, { encoding: "utf8" });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        const detected = new Set();
        // TODO: Make the final keyword configurable?
        const finalKeyword = "Server has completed startup and is now advertising for join.";
        let finalKeywordFound = false;

        rl.on('line', (line) => {
             // console.debug(`[Monitor][ShooterGame Log][${serverName}] line: ${line.substring(0,100)}...`);
            for (const { keyword, state } of shooterGameKeywords) {
                if (line.includes(keyword) && !detected.has(state)) {
                    detected.add(state);
                     console.debug(`[Monitor][ShooterGame Log][${serverName}] Keyword detected: "${keyword}" -> State: "${state}"`);

                    // Broadcast log event
                    broadcastImmediateEvent({
                        type: "monitoring",
                        scope: "server",
                        target: serverName,
                        event: "log",
                        data: { message: state, timestamp: Date.now(), source: "shootergame" }
                    });

                    if (keyword === finalKeyword) {
                        finalKeywordFound = true;
                         console.debug(`[Monitor][ShooterGame Log][${serverName}] Final keyword detected.`);
                        // Don't close immediately, let stream end. Might need tailing later.
                        // rl.close();
                    }
                }
            }
        });

        rl.on('close', () => {
             console.log(`[Monitor][ShooterGame Log][${serverName}] Log stream closed.`);
             // If the final keyword wasn't found, it might indicate an incomplete startup
            if (!finalKeywordFound) {
                 console.warn(`[Monitor][ShooterGame Log][${serverName}] Stream closed BUT final keyword was NOT detected.`);
                 // Should perhaps reject here or let monitorServerState handle it?
                 // For now, resolve, but this is a potential issue point.
            }
            resolve();
        });

        rl.on('error', (err) => {
            console.error(`❌ [Monitor][ShooterGame Log][${serverName}] Error reading log stream:`, err.message);
            reject(err);
        });

         // Safety timeout
         // setTimeout(() => {
         //     if (!rl.closed) {
         //         console.warn(`[Monitor][ShooterGame Log][${serverName}] Stream timeout reached. Closing.`);
         //         rl.close();
         //     }
         // }, 300000); // 5 minutes timeout for ShooterGame log phase
    });
}


/**
 * Orchestrates the monitoring of a server during its startup sequence.
 * Monitors Docker logs, then ShooterGame logs, and updates status accordingly.
 * @param {string} serverName - The name of the server to monitor.
 */
async function monitorServerState(serverName) {
    const containerName = `ARK-ASA-${serverName}`;
    let monitorFailed = false;

    try {
        console.log(`[Monitor State][${serverName}] Starting state monitoring sequence.`);
        updateAndNotifyStatus(serverName, "startup"); // Set initial status

        // --- Monitor Docker Logs Phase ---
        console.log(`[Monitor State][${serverName}] Monitoring Docker logs...`);
        await monitorDockerLogs(serverName, containerName);
        console.log(`[Monitor State][${serverName}] Docker logs monitoring phase complete.`);

        // --- Monitor ShooterGame Logs Phase ---
        // Add a small delay before checking ShooterGame logs?
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 sec delay
        console.log(`[Monitor State][${serverName}] Monitoring ShooterGame logs...`);
        await monitorShooterGameLog(serverName);
        console.log(`[Monitor State][${serverName}] ShooterGame logs monitoring phase complete.`);

        // --- Check if stats are flowing ---
        // At this point, stats *should* ideally be flowing if the server is healthy.
        // We rely on consumeStatsStream to call updateAndNotifyStatus('running') when stats arrive.
        // If stats haven't arrived shortly after ShooterGame logs finish, there might be an issue.

        // Add a final check/timeout for the 'running' state based on stats
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15s for stats confirmation

        if (cache.serversStatus[serverName]?.status === 'startup') {
             console.warn(`[Monitor State][${serverName}] Server finished log phases but stats confirmation pending or status still 'startup'. Forcing 'running' check.`);
             // If stats *are* in cache, force update. If not, might be an issue.
             if (cache.containersStats[serverName]) {
                 updateAndNotifyStatus(serverName, 'running');
             } else {
                  console.error(`[Monitor State][${serverName}] ERROR: Server log phases complete, but no stats received. Marking as error.`);
                  monitorFailed = true;
                  updateAndNotifyStatus(serverName, 'error', { error: 'Stats not received after startup logs.' });
             }
        } else if (cache.serversStatus[serverName]?.status === 'running') {
            console.log(`[Monitor State][${serverName}] Confirmed 'running' state (likely via stats stream). Monitoring sequence complete.`);
        } else {
            console.log(`[Monitor State][${serverName}] Monitoring sequence complete. Final status: ${cache.serversStatus[serverName]?.status}`);
        }


    } catch (err) {
        console.error(`❌ [Monitor State][${serverName}] Error during state monitoring sequence:`, err.message);
        monitorFailed = true;
        updateAndNotifyStatus(serverName, "error", { error: err.message || 'Monitoring sequence failed.' });
    }

    // Safety timeout removed - relying on state checks now.
    // Consider adding back if servers hang indefinitely without erroring.
}


module.exports = {
    setWebSocketInstance,
    monitorServerState,
    // updateMonitoringCache, // Might be less relevant now, initMonitoring handles cache setup
    monitorDockerLogs,
    monitorShooterGameLog,
    // setServerStatus, // Internal cache helper, maybe not export?
    // setHostStats, // Internal cache helper, maybe not export?
    broadcastImmediateEvent, // Useful for other modules potentially?
    initMonitoring,
    updateAndNotifyStatus // Central function for status changes
};