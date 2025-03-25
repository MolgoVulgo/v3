const http = require('http');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { findServerByName } = require("../models/serverModel");
const cache = require('../utils/cache');

let dockerApiVersion = 'v1.48';
let websocketInstance = null;
const statsEmitter = new EventEmitter();
const lastStatsCache = {};
/*=======================================================================
 *                      DOCKER SOCKET INITIALIZATION
 *======================================================================*/

/**
 * Initializes the Docker API version dynamically by querying the Docker socket.
 */
async function initDockerVersion() {
    return new Promise((resolve) => {
        const options = { socketPath: '/var/run/docker.sock', path: '/version', method: 'GET' };
        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    dockerApiVersion = json.ApiVersion ? `v${json.ApiVersion}` : dockerApiVersion;
                    resolve();
                } catch { resolve(); }
            });
        });
        req.on('error', () => resolve());
        req.end();
    });
}

/*=======================================================================
 *                      DOCKER SOCKET HELPER
 *======================================================================*/

/**
 * Sets the WebSocket instance for real-time monitoring and initializes stats event listener.
 * @param {WebSocket.Server} ws - WebSocket server instance.
 */
function setWebSocketInstance(ws) {
    websocketInstance = ws;
    setupStatsEventListener(ws);
}

/**
 * Sends a request to the Docker socket API.
 * @param {string} path - Docker API path.
 * @param {string} method - HTTP method.
 * @param {Object|null} data - Request body data if applicable.
 * @param {boolean} isStream - Whether to process response as stream.
 * @returns {Promise<any>} - Parsed Docker API response.
 */
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
                    resolve(isStream ? responseData.trim().split('\n').map(JSON.parse) : JSON.parse(responseData || '{}'));
                } else if (res.statusCode === 404) resolve(null);
                else reject(new Error(`Docker API Error ${method} ${options.path}: ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}


/*=======================================================================
 *                 REAL-TIME STATS STREAMING & EVENT LISTENER
 *======================================================================*/

/**
 * Streams real-time stats of a specific Docker container.
 * Emits 'stats' events with container ID and stat object.
 * @param {string} containerId - ID of the container.
 */
function streamContainerStats(containerId) {
    return new Promise((resolve, reject) => {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/containers/${containerId}/stats?stream=true`,
            method: 'GET'
        };
        const req = http.request(options, res => {
            res.on('data', chunk => {
                try {
                    const stat = JSON.parse(chunk.toString());
                    statsEmitter.emit('stats', containerId, stat);
                } catch { }
            });
            res.on('end', () => {
                statsEmitter.emit('containerStopped', containerId);
                resolve();
            });
        });
        req.on('error', reject);
        req.end();
    });
}
async function startStatsStreamingForAllContainers() {
    const containers = await listContainers();
    console.log(`📊 Starting stats streaming for ${containers.length} containers...`)   ;
    containers.forEach(container => {
        streamContainerStats(container.Id).catch(err => {
            console.error(`Stats stream error for ${container.Id}:`, err.message);
        });
    });
}

/**
 * Listens to stats events and sends updates via WebSocket when CPU or memory usage changes.
 * @param {WebSocket.Server} wss - WebSocket server instance.
 */

function setupStatsEventListener(wss) {
    console.debug(wss);
    console.debug("📡 Setting up stats event listener...");
    statsEmitter.on('stats', async (containerId, stat) => {
        console.debug(stat);
        const cpuPercent = calculateCPUPercentage(stat);
        const memUsage = stat.memory_stats.usage || 0;
        const memLimit = stat.memory_stats.limit || 1;

        const current = { CPU_USAGE: cpuPercent, MEMORY_USAGE: { used: memUsage, total: memLimit } };
        console.debug(current);
        const last = lastStatsCache[containerId];
        if (!last || last.CPU_USAGE !== current.CPU_USAGE || last.MEMORY_USAGE.used !== current.MEMORY_USAGE.used) {
            lastStatsCache[containerId] = current;

            const containers = await listContainers();
            const container = containers.find(c => c.Id === containerId);
            const serverName = container ? container.Names[0].replace('/', '').replace('ARK-ASA-', '') : 'Unknown';

            // 🟢 Mise à jour du cache temps réel
            cache.containersStats[serverName] = {
                name: serverName,
                CPU_USAGE: cpuPercent,
                MEMORY_USAGE: { used: memUsage, total: memLimit }
            };

            if (wss) {
                wss.clients.forEach(client => {
                    if (client.readyState === 1) {
                        client.send(JSON.stringify({
                            type: "monitoring",
                            scope: "container",
                            target: serverName,
                            event: "stats",
                            data: cache.containersStats[serverName]
                        }));
                    }
                });
            }

            // 🟢 Mise à jour du host stats
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;

            cache.hostStats = {
                CPU_USAGE: Object.values(cache.containersStats).reduce((acc, s) => acc + s.CPU_USAGE, 0),
                MEMORY_USAGE: {
                    used: usedMem,
                    total: totalMem
                }
            };

            console.debug(cache);
            // Diffusion du host stats
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: "monitoring",
                        scope: "host",
                        target: "host",
                        event: "stats",
                        data: cache.hostStats
                    }));
                }
            });
        }
    });

    statsEmitter.on('containerStopped', async (containerId) => {
        const containers = await listContainers();
        const container = containers.find(c => c.Id === containerId);
        const serverName = container ? container.Names[0].replace('/', '').replace('ARK-ASA-', '') : 'Unknown';

        if (wss) {
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: "monitoring",
                        scope: "server",
                        target: serverName,
                        event: "status",
                        data: {
                            status: "off",
                            CPU_USAGE: "N/A",
                            MEMORY_USAGE: "N/A",
                            detectedState: "stopped"
                        }
                    }));
                }
            });
        }
    });
}


/**
 * Lists all running Docker containers.
 * @returns {Promise<Array>} - List of containers.
 */
function listContainers() {
    return dockerRequest('/containers/json', 'GET');
}


/**
 * Pushes host-level CPU and memory stats via WebSocket.
 * @param {WebSocket.Server} wss - WebSocket server instance.
 * @param {Object} stats - Host stats object.
 */
function pushHostStats(wss, stats) {
    wss.clients.forEach(client => {
        if (client.readyState === 1) {
            client.send(JSON.stringify({
                type: "monitoring",
                scope: "host",
                target: "host",
                event: "stats",
                data: stats
            }));
        }
    });
}

/**
 * Calculates CPU usage percentage from Docker stats object.
 * @param {Object} stats - Docker stats object.
 * @returns {number} - CPU usage percentage.
 */
function calculateCPUPercentage(stats) {
    console.log(stats);

    try {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const cpuCount = stats.cpu_stats.online_cpus || os.cpus().length;
        return systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
    } catch { return 0; }
}



/*=======================================================================
 *                      DOCKER SERVER ACTIONS
 *======================================================================*/

/**
 * Starts a server by creating its Docker container.
 * @param {string} serverName - Name of the server.
 */
async function executeStartServer(serverName) {
    const server = findServerByName(serverName);
    if (!server) throw new Error(`Server ${serverName} not found`);
    await createServerContainer(server);
}

/**
 * Stops a running Docker container associated with a server.
 * @param {string} serverName - Name of the server.
 */
async function executeStopServer(serverName) {
    await dockerRequest(`/containers/ARK-ASA-${serverName}/stop`, 'POST');
}

/**
 * Restarts a server by stopping and starting its Docker container.
 * @param {string} serverName - Name of the server.
 */
async function executeRestartServer(serverName) {
    await executeStopServer(serverName);
    await executeStartServer(serverName);
}

/**
 * Checks if a specific Docker container exists.
 * @param {string} containerName - Name of the container.
 * @returns {Promise<boolean>} - True if exists.
 */
async function checkContainerExists(containerName) {
    return !!await dockerRequest(`/containers/${containerName}/json`, 'GET').catch(() => null);
}

/**
 * Removes a Docker container if it exists.
 * @param {string} containerName - Name of the container.
 */
async function removeContainer(containerName) {
    if (await checkContainerExists(containerName))
        await dockerRequest(`/containers/${containerName}?force=true`, 'DELETE');
}

/**
 * Checks if a server's Docker container is running.
 * @param {string} serverName - Server name.
 * @returns {Promise<string>} - "running" or "off".
 */
async function isServerRunning(serverName) {
    const containerInfo = await dockerRequest(`/containers/ARK-ASA-${serverName}/json`, 'GET');
    return containerInfo?.State?.Running ? "running" : "off";
}

/**
 * Streams logs from a Docker container.
 * @param {string} containerName - Name of the container.
 * @returns {Promise<Array>} - Streamed log lines.
 */
function streamDockerLogs(containerName) {
    return dockerRequest(`/containers/${containerName}/logs?stdout=true&stderr=true&follow=true`, 'GET', null, true);
}

/*=======================================================================
 *                    DOCKER UTILITIES & CONFIGURATION
 *======================================================================*/

/**
 * Creates and starts a Docker container for the server with proper configuration.
 * @param {Object} server - Server configuration object.
 */
async function createServerContainer(server) {
    try {
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
            Hostname: `ARK-ASA-${server.SERVER_NAME}`,
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

        const imageName = "mschnitzer/asa-linux-server:latest";
        await ensureDockerImageExists(imageName);
        await setPermissions();
        await dockerRequest(`/containers/create?name=${containerName}`, 'POST', config);
        console.log(`✅ Container ${containerName} created.`);
        await dockerRequest(`/containers/${containerName}/start`, 'POST');
        console.log(`🚀 Container ${containerName} started.`);
    } catch (err) {
        console.log(`❌ Docker API Error:`, err.response?.data || err.message);
        throw err;
    }
}

/**
 * Sets permissions for shared directories via temporary Docker container.
 */
async function setPermissions() {
    const containerName = "set-permissions";
    const imageName = "opensuse/leap";

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

    try {
        await dockerRequest(`/containers/${containerName}?force=true`, 'DELETE').catch(() => null);
        await dockerRequest(`/containers/create?name=${containerName}`, 'POST', config);
        console.log(`✅ Container ${containerName} créé.`);
        await dockerRequest(`/containers/${containerName}/start`, 'POST');
        console.log(`🔧 Permissions mises à jour avec succès par ${containerName}.`);
        await dockerRequest(`/containers/${containerName}/wait`, 'POST');
        console.log(`✅ Container ${containerName} terminé et supprimé automatiquement.`);
    } catch (err) {
        console.error(`❌ Erreur mise à jour permissions: ${err.message}`);
        throw err;
    }
}

/**
 * Generates a unique cluster ID (UUID format).
 * @returns {string} - Cluster ID.
 */
function generateClusterId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/**
 * Ensures required Docker image exists locally, pulls if necessary.
 * @param {string} imageName - Name of the Docker image.
 */
async function ensureDockerImageExists(imageName) {
    try {
        const images = await dockerRequest(`/images/json`, 'GET');
        const imageExists = images.some(image => image.RepoTags && image.RepoTags.includes(imageName));

        if (!imageExists) {
            console.log(`📥 Pulling Docker image: ${imageName}...`);
            await dockerRequest(`/images/create?fromImage=${encodeURIComponent(imageName)}`, 'POST', null, true);
            console.log(`✅ Docker image ${imageName} pulled successfully.`);
        } else {
            console.log(`🐳 Docker image ${imageName} already exists locally.`);
        }
    } catch (err) {
        console.error(`❌ Failed to ensure Docker image '${imageName}':`, err.message);
        throw err;
    }
}

/**
 * Ensures the Docker network for the cluster exists, creates if absent.
 * @param {string} clusterId - Unique cluster identifier.
 * @returns {Promise<string>} - Docker network name.
 */
async function ensureNetworkExists(clusterId) {
    const networkName = `asa-network-${clusterId}`;

    try {
        const existingNetwork = await dockerRequest(`/networks/${networkName}`, 'GET');
        if (existingNetwork) {
            console.log(`🌐 Docker network '${networkName}' already exists.`);
        } else {
            console.log(`🌐 Docker network '${networkName}' does not exist, creating...`);
            const networkConfig = {
                Name: networkName,
                Driver: "bridge",
                Attachable: true
            };
            await dockerRequest('/networks/create', 'POST', networkConfig);
            console.log(`✅ Docker network '${networkName}' created.`);
        }
        return networkName;
    } catch (err) {
        console.error(`❌ Failed to ensure Docker network '${networkName}':`, err.message);
        throw err;
    }
}

/*=======================================================================
 *                        EXPORTS
 *======================================================================*/

module.exports = {
    initDockerVersion,
    setWebSocketInstance,
    dockerRequest,
    streamContainerStats,
    startStatsStreamingForAllContainers,
    pushHostStats,
    listContainers,
    executeStartServer,
    executeStopServer,
    executeRestartServer,
    checkContainerExists,
    removeContainer,
    isServerRunning,
    streamDockerLogs
};
