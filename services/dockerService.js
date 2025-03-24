const http = require('http');
const os = require('os');
const path = require('path');
const { findServerByName } = require("../models/serverModel");

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
                    } else {
                        console.warn(`⚠️ Docker API Version not found, using default: ${dockerApiVersion}`);
                    }
                    resolve();
                } catch (err) {
                    console.warn(`⚠️ Error parsing Docker version: ${err.message}`);
                    resolve();
                }
            });
        });

        req.on('error', (err) => {
            console.warn(`⚠️ Error contacting Docker daemon: ${err.message}`);
            resolve();
        });

        req.end();
    });
}

/*=======================================================================
 *                      DOCKER SOCKET HELPER
 *======================================================================*/

function setWebSocketInstance(ws) {
    websocketInstance = ws;
}

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
                        const jsonLines = lines.map(line => JSON.parse(line));
                        resolve(jsonLines);
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
 *                        STATS & MONITORING
 *======================================================================*/

async function getDockerStats() {
    try {
        const containers = await listContainers();
        const statsPromises = containers.map(container => getContainerStats(container.Id));
        const containersStatsRaw = await Promise.all(statsPromises);

        let totalCPU = 0;
        const containersStats = {};

        containersStatsRaw.forEach((stat, index) => {
            const cpuPercent = calculateCPUPercentage(stat);
            totalCPU += cpuPercent;

            let memUsage = stat.memory_stats.usage || 0;
            const memLimit = stat.memory_stats.limit || 1;

            containersStats[containers[index].Id] = {
                name: containers[index].Names[0].replace('/', ''),
                CPU_USAGE: cpuPercent,
                MEMORY_USAGE: { used: memUsage, total: memLimit }
            };
        });

        const totalMem = os.totalmem();
        const usedMem = totalMem - os.freemem();

        const stats = {
            CPU_USAGE: totalCPU,
            MEMORY_USAGE: { used: usedMem, total: totalMem },
            containersStats
        };

        // Diffusion immédiate via WebSocket
        if (websocketInstance) {
            websocketInstance.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ event: 'host:stats', data: stats }));
                }
            });
        }

        return stats;

    } catch (err) {
        console.error("❌ Error in getDockerStats:", err.message);
        return { CPU_USAGE: 0, MEMORY_USAGE: { used: 0, total: 0 }, containersStats: {} };
    }
}

function listContainers() {
    return dockerRequest('/containers/json', 'GET');
}

function getContainerStats(containerId) {
    return dockerRequest(`/containers/${containerId}/stats?stream=false`, 'GET');
}

function calculateCPUPercentage(stats) {
    try {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const cpuCount = stats.cpu_stats.online_cpus || os.cpus().length;
        return systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
    } catch (err) {
        return 0;
    }
}

/*=======================================================================
 *                      DOCKER SERVER ACTIONS
 *======================================================================*/

async function executeStopServer(serverName) {
    const containerName = `ARK-ASA-${serverName}`;
    await dockerRequest(`/containers/${containerName}/stop`, 'POST');
}

async function isServerRunning(serverName) {
    const containerName = `ARK-ASA-${serverName}`;
    const containerInfo = await dockerRequest(`/containers/${containerName}/json`, 'GET');
    return containerInfo && containerInfo.State.Running ? "running" : "off";
}

function streamDockerLogs(containerName) {
    const logPath = `/containers/${containerName}/logs?stdout=true&stderr=true&follow=true`;
    return dockerRequest(logPath, 'GET', null, true);
}

/*=======================================================================
 *                        EXPORTS
 *======================================================================*/

module.exports = {
    initDockerVersion,
    setWebSocketInstance,
    dockerRequest,
    getDockerStats,
    executeStopServer,
    isServerRunning,
    streamDockerLogs
};
