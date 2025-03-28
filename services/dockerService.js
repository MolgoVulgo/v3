const http = require('http');
const os = require('os');
const path = require('path');
const { findServerByName } = require("../models/serverModel");
const cache = require('../utils/cache');

let dockerApiVersion = 'v1.48'; // Default fallback
let websocketInstance = null;

/*=======================================================================
 *                      DOCKER SOCKET INITIALISATION
 *======================================================================*/

async function initDockerVersion() {
    return new Promise((resolve) => {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: '/version',
            method: 'GET'
        };

        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.ApiVersion) {
                        dockerApiVersion = `v${json.ApiVersion}`;
                        console.log(`🛠️ Docker API Version detected: ${dockerApiVersion}`);
                    }
                    resolve();
                } catch {
                    resolve();
                }
            });
        });

        req.on('error', () => resolve());
        req.end();
    });
}

function setWebSocketInstance(ws) {
    websocketInstance = ws;
}

/*=======================================================================
 *                      DOCKER SOCKET HELPER
 *======================================================================*/

function dockerRequest(path, method = 'GET', data = null, isStream = false) {
    return new Promise((resolve, reject) => {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/${dockerApiVersion}${path}`,
            method,
            headers: {}
        };

        let body = null;
        if (data) {
            body = JSON.stringify(data);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = http.request(options, res => {
            let responseData = '';
            res.on('data', chunk => { responseData += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    if (isStream) {
                        const lines = responseData.trim().split('\n');
                        const parsedLines = lines.map(line => {
                            try {
                                return JSON.parse(line);
                            } catch {
                                return { raw: line };
                            }
                        });
                        resolve(parsedLines);
                    } else {
                        resolve(responseData ? JSON.parse(responseData) : {});
                    }
                } else if (res.statusCode === 404) {
                    resolve(null);
                } else {
                    reject(new Error(`Docker API Error ${method} ${options.path}: ${res.statusCode}`));
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

/*=======================================================================
 *                        STREAMING STATS
 *======================================================================*/


async function streamContainerStats(containerId, containerName) {
    try {
        const path = `/containers/${containerId}/stats?stream=true`;

        console.debug(`[STREAM] Connexion directe au flux Docker stats pour ${containerName}`);

        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/${dockerApiVersion}${path}`,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        };

        const req = http.request(options, res => {
            let buffer = '';

            res.on('data', chunk => {
                buffer += chunk.toString();

                const lines = buffer.split('\n');
                buffer = lines.pop(); // garde une ligne partielle éventuelle

                lines.forEach(line => {
                    try {
                        const stat = JSON.parse(line);
        //console.debug(`[STATS] Nouvelle donnée pour ${containerName}:`, stat);
                        const cpuPercent = calculateCPUPercentage(stat);
                        const rawUsage = stat.memory_stats?.usage || 0;
                        const file = stat.memory_stats?.stats?.file || 0;
                        const memUsage = Math.max(0, rawUsage - file); // estimation réaliste sans cache
                        const memLimit = stat.memory_stats?.limit || 1;

                        // MAJ cache container
                        cache.containersStats[containerName] = {
                            name: containerName,
                            CPU_USAGE: cpuPercent,
                            MEMORY_USAGE: {
                                used: memUsage,
                                total: memLimit
                            }
                        };

                        // MAJ cache host
                        const totalMem = os.totalmem();
                        const freeMem = os.freemem();
                        cache.hostStats = {
                            CPU_USAGE: cpuPercent,
                            MEMORY_USAGE: {
                                used: totalMem - freeMem,
                                total: totalMem
                            }
                        };

                        // WebSocket broadcast
                        if (websocketInstance) {
                            websocketInstance.clients.forEach(client => {
                                if (client.readyState === 1) {
                                    // Host
                                    client.send(JSON.stringify({
                                        type: "monitoring",
                                        scope: "host",
                                        target: "host",
                                        event: "stats",
                                        data: cache.hostStats
                                    }));

                                    // Container
                                    client.send(JSON.stringify({
                                        type: "monitoring",
                                        scope: "container",
                                        target: containerName,
                                        event: "stats",
                                        data: cache.containersStats[containerName]
                                    }));

                                    // Server enrichi (si pas encore fait)
                                    const serverName = containerName.replace('ARK-ASA-', '');
                                    const currentStatus = cache.serversStatus[serverName]?.status;
                                    const currentCPU = cache.serversStatus[serverName]?.CPU_USAGE;

                                    if (
                                        (currentStatus === "running" || currentStatus === "startup") &&
                                        (currentCPU === "N/A" || currentCPU === undefined)
                                    ) {
                                        console.debug(`[WS] Envoi enrichi monitoring/server/status pour ${serverName}`);
                                        monitorsService.updateAndNotifyStatus(serverName, "running");
                                    }
                                }
                            });
                        }

                    } catch (e) {
                        console.warn(`[WARN] Chunk non parsable dans stats stream pour ${containerName}`);
                    }
                });
            });

            res.on('end', () => {
                console.log(`[END] Stream stats terminé pour ${containerName}`);
            });
        });

        req.on('error', (err) => {
            console.error(`❌ Stream stats échoué pour ${containerName}:`, err.message);
        });

        req.end();

    } catch (err) {
        console.error(`❌ Erreur dans streamContainerStats pour ${containerName}:`, err.message);
    }
}

function calculateCPUPercentage(stats) {
    try {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const cpuCount = stats.cpu_stats.online_cpus || os.cpus().length;
        if (systemDelta > 0 && cpuDelta > 0) {
            return (cpuDelta / systemDelta) * cpuCount * 100;
        }
        return 0;
    } catch {
        return 0;
    }
}

async function startStatsStreamingForAllContainers() {
    try {
        const containers = await listContainers();

        containers.forEach(container => {
            const containerName = container.Names[0].replace('/', '');

            if (containerName.startsWith('ARK-ASA-')) {
                const serverName = containerName.replace('ARK-ASA-', '');
                console.debug(`[STREAM] Démarrage du stream stats pour ${serverName}`);
                streamContainerStats(container.Id, serverName);
            }
        });

        console.log("🚀 streamContainerStats lancé pour tous les containers actifs.");
    } catch (err) {
        console.error("❌ Erreur dans startStatsStreamingForAllContainers:", err.message);
    }
}


/*=======================================================================
 *                        DOCKER COMMANDS
 *======================================================================*/

async function listContainers() {
    return dockerRequest('/containers/json', 'GET');
}

async function checkContainerExists(containerName) {
    const result = await dockerRequest(`/containers/${containerName}/json`, 'GET').catch(() => null);
    return !!result;
}

async function removeContainer(containerName) {
    const exists = await checkContainerExists(containerName);
    if (exists) {
        await dockerRequest(`/containers/${containerName}?force=true`, 'DELETE');
    }
}

async function ensureNetworkExists(clusterId) {
    const networkName = `asa-network-${clusterId}`;
    const existing = await dockerRequest(`/networks/${networkName}`, 'GET');
    if (!existing) {
        await dockerRequest('/networks/create', 'POST', {
            Name: networkName,
            Driver: "bridge",
            Attachable: true
        });
    }
    return networkName;
}

async function ensureDockerImageExists(imageName) {
    const images = await dockerRequest('/images/json');
    const found = images.some(image => image.RepoTags?.includes(imageName));
    if (!found) {
        await dockerRequest(`/images/create?fromImage=${encodeURIComponent(imageName)}`, 'POST', null, true);
    }
}

async function setPermissions() {
    const imageName = "opensuse/leap";
    const containerName = "set-permissions";

    await ensureDockerImageExists(imageName);

    const config = {
        Image: imageName,
        Entrypoint: ["/bin/bash", "-c", "chown -R 25000:25000 /steam /steamcmd /cluster-shared /server-files"],
        User: "root",
        HostConfig: {
            Binds: [
                path.resolve('../steam') + ':/steam:rw',
                path.resolve('../steamcmd') + ':/steamcmd:rw',
                path.resolve('../cluster-shared') + ':/cluster-shared:rw',
                path.resolve('../server-files') + ':/server-files:rw'
            ],
            AutoRemove: true
        }
    };

    await dockerRequest(`/containers/${containerName}?force=true`, 'DELETE').catch(() => null);
    await dockerRequest(`/containers/create?name=${containerName}`, 'POST', config);
    await dockerRequest(`/containers/${containerName}/start`, 'POST');
    await dockerRequest(`/containers/${containerName}/wait`, 'POST');
}

async function createServerContainer(server) {
    server.CLUSTER_ID = server.CLUSTER_ID || generateClusterId();
    const containerName = `ARK-ASA-${server.SERVER_NAME}`;
    const networkName = await ensureNetworkExists(server.CLUSTER_ID);

    await removeContainer(containerName);

    const binds = [
        path.resolve(`../server-files/${server.SERVER_NAME}`) + ':/home/gameserver/server-files:rw',
        path.resolve(`../steam`) + ':/home/gameserver/steam:rw',
        path.resolve(`../steamcmd`) + ':/home/gameserver/steamcmd:rw',
        path.resolve(`../cluster-shared`) + ':/home/gameserver/cluster-shared:rw',
        '/etc/localtime:/etc/localtime:ro'
    ];

    const config = {
        Image: "mschnitzer/asa-linux-server:latest",
        name: containerName,
        Entrypoint: ["/usr/bin/start_server"],
        Hostname: containerName,
        User: "gameserver",
        Tty: true,
        OpenStdin: true,
        Env: [
            `ASA_START_PARAMS=${server.MAP_NAME}_WP?listen?Port=${server.PORT}?RCONPort=${server.RCON_PORT}?RCONEnabled=True -UseDynamicConfig -WinLiveMaxPlayers=${server.MAX_PLAYERS} -clusterid=${server.CLUSTER_ID} -ClusterDirOverride="/home/gameserver/cluster-shared" -mods=${server.MODS}`,
            `ENABLE_DEBUG=0`
        ],
        HostConfig: {
            PortBindings: {
                [`${server.PORT}/udp`]: [{ HostPort: `${server.PORT}` }],
                [`${server.RCON_PORT}/tcp`]: [{ HostPort: `${server.RCON_PORT}` }]
            },
            Binds: binds,
            NetworkMode: networkName
        },
        NetworkingConfig: {
            EndpointsConfig: {
                [networkName]: {}
            }
        }
    };

    await ensureDockerImageExists(config.Image);
    await setPermissions();
    await dockerRequest(`/containers/create?name=${containerName}`, 'POST', config);
    await dockerRequest(`/containers/${containerName}/start`, 'POST');
}

async function executeStartServer(serverName) {
    const server = findServerByName(serverName);
    if (!server) throw new Error(`Server ${serverName} not found`);
    await createServerContainer(server);
}

async function executeStopServer(serverName) {
    const containerName = `ARK-ASA-${serverName}`;
    await dockerRequest(`/containers/${containerName}/stop`, 'POST');
}

async function executeRestartServer(serverName) {
    await executeStopServer(serverName);
    await executeStartServer(serverName);
}

function streamDockerLogs(containerName) {
    return dockerRequest(`/containers/${containerName}/logs?stdout=true&stderr=true&follow=true`, 'GET', null, true);
}

function generateClusterId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

/*=======================================================================
 *                        EXPORTS
 *======================================================================*/

module.exports = {
    executeStartServer,
    executeStopServer,
    executeRestartServer,
    checkContainerExists,
    removeContainer,
    initDockerVersion,
    setWebSocketInstance,
    dockerRequest,
    streamDockerLogs,
    listContainers,
    streamContainerStats,
    startStatsStreamingForAllContainers
};
