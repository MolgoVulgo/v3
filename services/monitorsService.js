const os = require('os');
const cache = require('../utils/cache');
const dockerService = require('./dockerService');
const readline = require('readline');
const { Readable } = require('stream');
const { loadServersConfig } = require('../models/serverModel');

const shooterGameKeywords = require("../config/ShooterGameKeyword.json");
const dockerKeywords = require("../config/dockerKeyword.json");

let websocketInstance = null;
let hostStatsInitialized = false;

function setWebSocketInstance(ws) {
    websocketInstance = ws;
}

function broadcastImmediateEvent(eventObject) {
    if (websocketInstance) {
        websocketInstance.clients.forEach(client => {
            if (client.readyState === 1) {
                client.send(JSON.stringify(eventObject));
            }
        });
    }
}

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

function setHostStats(stats = {}) {
    cache.hostStats = {
        ...cache.hostStats,
        ...stats
    };
}

async function updateMonitoringCache() {
    try {
        const servers = loadServersConfig();

        for (const server of servers) {
            const serverName = server.SERVER_NAME;

            setServerStatus(serverName, {
                ...server,
                status: 'off',
                detectedState: 'off',
                CPU_USAGE: "N/A",
                MEMORY_USAGE: "N/A"
            });
        }

        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        const cpuUsage = getHostCPUUsage();

        cache.hostStats = {
            CPU_USAGE: cpuUsage,
            MEMORY_USAGE: {
                used: usedMem,
                total: totalMem
            }
        };

    } catch (err) {
        console.error("❌ Failed to update monitoring cache:", err.message);
    }
}

function getHostCPUUsage() {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;

    cpus.forEach(cpu => {
        for (let type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;

    return +(100 - (100 * idle / total)).toFixed(2);
}

async function monitorDockerLogs(serverName, containerName) {
    return new Promise(async (resolve, reject) => {
        try {
            console.debug(`[monitorDockerLogs] Démarrage de la surveillance Docker pour ${serverName} (${containerName})`);

            const stream = await dockerService.streamDockerLogs(containerName);
            
            console.debug(`[monitorDockerLogs] Type de stream:`, typeof stream);
            console.debug(`[monitorDockerLogs] Stream prototype:`, Object.getPrototypeOf(stream));
            console.debug(`[monitorDockerLogs] stream.on:`, typeof stream?.on);

            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });

            const detected = new Set();
            const finalKeyword = "wine: RLIMIT_NICE is <= 20, unable to use setpriority safely";

            rl.on('line', (logLine) => {
                logLine = logLine.toString().trim();
                console.debug(`[monitorDockerLogs][${serverName}] log: ${logLine}`);

                for (const { keyword, state } of dockerKeywords) {
                    if (logLine.includes(keyword) && !detected.has(state)) {
                        detected.add(state);
                        console.debug(`[monitorDockerLogs] Mot-clé détecté: "${keyword}" → État: "${state}"`);

                        broadcastImmediateEvent({
                            type: "monitoring",
                            scope: "server",
                            target: serverName,
                            event: "log",
                            data: { message: state, timestamp: Date.now() }
                        });

                        if (keyword === finalKeyword) {
                            console.debug(`[monitorDockerLogs] Mot-clé final détecté, fermeture du flux.`);
                            rl.close();
                        }
                    }
                }
            });

            rl.on('close', () => {
                console.debug(`[monitorDockerLogs] Surveillance terminée pour ${serverName}`);
                resolve();
            });

            rl.on('error', (err) => {
                console.error(`[monitorDockerLogs] Erreur stream Docker :`, err.message);
                reject(err);
            });

        } catch (err) {
            console.error(`[monitorDockerLogs] Erreur lors de la surveillance Docker pour ${serverName} :`, err);
            reject(err);
        }
    });
}


// async function monitorDockerLogs(serverName, containerName) {
//     return new Promise(async (resolve, reject) => {
//         try {
//             const stream = await dockerService.streamDockerLogs(containerName);
//             if (!Array.isArray(stream)) return reject("Stream vide ou invalide");

//             const rl = readline.createInterface({
//                 input: Readable.from(stream.map(line => JSON.stringify(line))),
//                 crlfDelay: Infinity
//             });

//             const detected = new Set();
//             const finalKeyword = "wine: RLIMIT_NICE is <= 20, unable to use setpriority safely";

//             rl.on('line', (rawLine) => {
//                 try {
//                     const parsed = JSON.parse(rawLine);
//                     const logLine = parsed.log || parsed.stream || '';

//                     for (const { keyword, state } of dockerKeywords) {
//                         if (logLine.includes(keyword) && !detected.has(state)) {
//                             detected.add(state);

//                             broadcastImmediateEvent({
//                                 type: "monitoring",
//                                 scope: "server",
//                                 target: serverName,
//                                 event: "log",
//                                 data: { message: state, timestamp: Date.now() }
//                             });

//                             if (keyword === finalKeyword) {
//                                 rl.close(); // On considère le flux Docker terminé
//                             }
//                         }
//                     }
//                 } catch (e) {
//                     console.warn(`[WARN] Ligne Docker non parsable pour ${serverName}`);
//                 }
//             });

//             rl.on('close', () => {
//                 resolve();
//             });

//         } catch (err) {
//             reject(err);
//         }
//     });
// }

async function monitorShooterGameLog(serverName) {
    return new Promise((resolve, reject) => {
        const logPath = path.join("server-files", serverName, "ShooterGame", "Saved", "Logs", "ShooterGame.log");

        if (!fs.existsSync(logPath)) {
            return reject(`Fichier log non trouvé : ${logPath}`);
        }

        const stream = fs.createReadStream(logPath, { encoding: "utf8" });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        const detected = new Set();
        const finalKeyword = "Server has completed startup and is now advertising for join.";

        rl.on('line', (line) => {
            for (const { keyword, state } of shooterGameKeywords) {
                if (line.includes(keyword) && !detected.has(state)) {
                    detected.add(state);

                    broadcastImmediateEvent({
                        type: "monitoring",
                        scope: "server",
                        target: serverName,
                        event: "log",
                        data: { message: state, timestamp: Date.now() }
                    });

                    if (keyword === finalKeyword) {
                        rl.close(); // Fin du suivi
                    }
                }
            }
        });

        rl.on('close', () => {
            resolve();
        });

        rl.on('error', (err) => {
            reject(err);
        });
    });
}


async function monitorServerState(serverName) {
    const containerName = `ARK-ASA-${serverName}`;

    try {
        console.log(`[MONITOR] Suivi de ${serverName} → état : startup`);
        updateAndNotifyStatus(serverName, "startup");

        await monitorDockerLogs(serverName, containerName);
        console.log(`[MONITOR] Docker logs terminés pour ${serverName}`);

        await monitorShooterGameLog(serverName);
        console.log(`[MONITOR] ShooterGame.log analysé pour ${serverName}`);

        updateAndNotifyStatus(serverName, "running");
        console.log(`[MONITOR] ${serverName} est maintenant en état 'running'`);

    } catch (err) {
        console.error(`❌ monitorServerState error pour ${serverName}:`, err.message);
        updateAndNotifyStatus(serverName, "error");
    }

    // Timeout sécurité : arrêt du serveur si bloqué en startup
    setTimeout(() => {
        const current = cache.serversStatus[serverName];
        if (!current || current.status === 'startup') {
            console.warn(`[TIMEOUT] ${serverName} est resté bloqué en 'startup' → arrêt`);
            dockerService.executeStopServer(serverName);
        }
    }, 300000);
}

async function monitorHostStatsContinuously() {
    let prevIdle = 0;
    let prevTotal = 0;

    function getCPUUsage() {
        const cpus = os.cpus();
        let idle = 0;
        let total = 0;

        cpus.forEach((cpu) => {
            for (const type in cpu.times) {
                total += cpu.times[type];
            }
            idle += cpu.times.idle;
        });

        const idleDiff = idle - prevIdle;
        const totalDiff = total - prevTotal;
        prevIdle = idle;
        prevTotal = total;

        const usage = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
        return usage.toFixed(1);
    }

    while (true) {
        const cpuUsage = getCPUUsage();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;

        const hostStats = {
                        CPU_USAGE: `${cpuUsage}%`,
                        MEMORY_USAGE: {
                            used: usedMem,
                            total: totalMem
                        }
                    };

        setHostStats(hostStats);

        if (websocketInstance) {
            broadcastImmediateEvent({
                type: 'monitoring',
                scope: 'host',
                target: 'host',
                event: 'stats',
                data: hostStats,
            });
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
    }
}

async function initMonitoring() {
    await updateMonitoringCache();

    try {
        const containers = await dockerService.listContainers();

        containers.forEach(container => {
            const name = container.Names[0].replace('/', '');

            if (name.startsWith('ARK-ASA-')) {
                const serverName = name.replace('ARK-ASA-', '');

                setServerStatus(serverName, {
                    status: 'running',
                    detectedState: 'running',
                    CPU_USAGE: 'N/A',
                    MEMORY_USAGE: 'N/A'
                });

                //monitorServerState(serverName);

                // 🔄 Lance aussi le stream Docker stats pour activer cache + ws
                console.debug(`[INIT] streamContainerStats lancé pour ${serverName}`);
                dockerService.startStatsStreamingForAllContainers();
            }
        });

        console.log("🔄 Monitoring initialized for active containers.");
    } catch (err) {
        console.error("❌ Failed to initialize monitoring from running containers:", err.message);
    }

    if (!hostStatsInitialized) {
        hostStatsInitialized = true;
        monitorHostStatsContinuously();
    }
}


/**
 * Met à jour le cache + notifie par WebSocket un changement de statut serveur.
 * 
 * @param {string} serverName - Nom du serveur concerné
 * @param {string} status - ex: "startup", "running", "off"
 * @param {Object} extra - valeurs facultatives à inclure (CPU_USAGE, MEMORY_USAGE, etc.)
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
    monitorServerState,
    updateMonitoringCache,
    monitorDockerLogs,
    monitorShooterGameLog,
    setServerStatus,
    setHostStats,
    broadcastImmediateEvent,
    initMonitoring,
    updateAndNotifyStatus
};
