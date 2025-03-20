const http = require('http');
const os = require('os');
const path = require('path');
const { findServerByName } = require("../models/serverModel");

let dockerApiVersion = 'v1.48'; // Default fallback

/*=======================================================================
 *                      DOCKER SOCKET INITIALISATION
 *======================================================================*/

/**
 * Initializes Docker API version by querying /version endpoint.
 */
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

/**
 * Sends an HTTP request to the Docker socket API.
 * @param {string} path - API endpoint path (without version prefix).
 * @param {string} method - HTTP method.
 * @param {Object|null} data - Data to send (if any).
 * @returns {Promise<Object>}
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
                    console.error(`❌ Docker API Error ${method} ${options.path}: ${res.statusCode}`);
                    console.error(`❌ Docker API Response: ${responseData}`);
                    reject(new Error(`Docker API Error ${method} ${options.path}: ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

/**
 * Ensures a unique Docker network per cluster exists, creates it if not.
 * @param {string} clusterId - The unique identifier for the cluster.
 * @returns {Promise<string>} - Returns the network name created or existing.
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
                // Pas de bridge name custom → Docker gère automatiquement
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

async function ensureDockerImageExists(imageName) {
    try {
        const images = await dockerRequest(`/images/json`, 'GET');
        const imageExists = images.some(image => image.RepoTags && image.RepoTags.includes(imageName));

        if (!imageExists) {
            console.log(`📥 Pulling Docker image: ${imageName}...`);
            
            // Passer "isStream=true" pour traiter le stream correctement
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



/*=======================================================================
 *                      DOCKER SERVER ACTIONS
 *======================================================================*/

async function checkContainerExists(containerName) {
    const result = await dockerRequest(`/containers/${containerName}/json`, 'GET').catch(() => null);
    return !!result;
}

async function removeContainer(containerName) {
    const exists = await checkContainerExists(containerName);
    if (exists) {
        console.log(`🗑️ Removing container ${containerName}`);
        await dockerRequest(`/containers/${containerName}?force=true`, 'DELETE');
    }
}

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
                Binds:binds,
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

async function setPermissions() {
    const containerName = "set-permissions";
    const imageName = "opensuse/leap";

    // Garantir la présence de l'image localement avant création
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

async function executeStartServer(serverName) {
    try {
        const server = findServerByName(serverName);
        console.debug(server);
        if (!server) throw new Error(`Server ${serverName} not found`);
        await createServerContainer(server);
    } catch (err) {
        console.error(`❌ Failed to start server ${serverName}:`, err.message);
    }
}

async function executeStopServer(serverName) {
    try {
        const containerName = `ARK-ASA-${serverName}`;
        console.log(`[DOCKER] Stopping server: ${containerName}`);
        await dockerRequest(`/containers/${containerName}/stop`, 'POST');
        console.log(`✅ Server ${containerName} stopped.`);
    } catch (err) {
        console.error(`❌ Failed to stop server ${serverName}:`, err.message);
    }
}

async function executeRestartServer(serverName) {
    await executeStopServer(serverName);
    await executeStartServer(serverName);
}

async function isServerRunning(serverName) {
    try {
        const containerName = `ARK-ASA-${serverName}`;
        const containerInfo = await dockerRequest(`/containers/${containerName}/json`, 'GET');

        if (!containerInfo) {
            // Le conteneur n'existe pas → serveur off
            return { status: "off", details: null };
        }

        const running = (containerInfo.State && containerInfo.State.Running) ? "running" : "off";

        const details = {
            status: running,
            startedAt: containerInfo.State.StartedAt,
            uptime: containerInfo.State.Running ? containerInfo.State.StartedAt : null,
            containerId: containerInfo.Id,
            image: containerInfo.Config.Image
        };

        return details;
    } catch (err) {
        // Cas critique (Docker down)
        console.error(`❌ Docker error while checking status of ${serverName}:`, err.message);
        return { status: "off", details: null };
    }
}


function generateClusterId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
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
    isServerRunning,
    initDockerVersion // À appeler au démarrage
};
