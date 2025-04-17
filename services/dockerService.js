/**
 * @fileoverview Service for interacting with the Docker Engine API using Dockerode.
 * Handles container creation, start, stop, restart, logs, and stats streaming.
 * @version 2.1.0 Refactored for Dockerode, fixed circular deps, added Entrypoint.
 */

// Third-party modules
const Docker = require('dockerode');

// Core Node.js modules
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream'); // For handling streams

// Application modules
const { findServerByName } = require("../models/serverModel");
// Note: cache and monitorsService are NOT imported here to avoid circular dependencies

// Instantiate Dockerode - Connects via default socket path /var/run/docker.sock
// Options can be passed if Docker daemon runs elsewhere: e.g., { host: '127.0.0.1', port: 2375 }
const docker = new Docker();

// This instance is kept for potential future use or interface compatibility,
// but this service no longer directly broadcasts WebSocket messages.
let websocketInstance = null;

/**
 * Sets the WebSocket server instance (currently unused by this service).
 * @param {*} ws - The WebSocket server instance.
 */
function setWebSocketInstance(ws) {
    console.warn("[dockerService] setWebSocketInstance called, but dockerService no longer broadcasts directly via it.");
    // websocketInstance = ws; // Assignation commentée
}

/*=======================================================================
 * HELPER FUNCTIONS (Dockerode)
 *======================================================================*/

/**
 * Wraps a Dockerode promise to handle 'Not Found' (404) errors gracefully.
 * @param {Promise<any>} promise - The Dockerode promise to wrap.
 * @returns {Promise<any|null>} - The result of the promise, or null if a 404 error occurred.
 * @throws {Error} - Propagates errors other than 404.
 */
async function handleNotFound(promise) {
    try {
        return await promise;
    } catch (error) {
        if (error.statusCode === 404) {
            return null; // Resource not found, return null consistently
        }
        // Log and re-throw other errors
        console.error("❌ Dockerode Error:", error.message, error.stack);
        throw error;
    }
}

/*=======================================================================
 * DOCKER COMMANDS (Refactored with Dockerode)
 *======================================================================*/

/**
 * Lists Docker containers.
 * @param {boolean} [all=true] - Whether to list all containers (including stopped ones).
 * @returns {Promise<object[]|null>} - A list of container objects, or null on error/not found.
 */
async function listContainers(all = true) {
    console.debug("[Dockerode] Listing containers...");
    // Use handleNotFound, although listContainers usually returns [] not 404
    return await handleNotFound(docker.listContainers({ all }));
}

/**
 * Checks if a container with the given name exists.
 * @param {string} containerName - The name of the container.
 * @returns {Promise<boolean>} - True if the container exists, false otherwise.
 */
async function checkContainerExists(containerName) {
    console.debug(`[Dockerode] Checking if container ${containerName} exists...`);
    const container = docker.getContainer(containerName);
    // Inspect returns container info if exists, throws 404 if not
    const inspection = await handleNotFound(container.inspect());
    const exists = !!inspection;
    console.debug(`[Dockerode] Container ${containerName} exists: ${exists}`);
    return exists;
}

/**
 * Removes a container forcefully.
 * Handles cases where the container doesn't exist.
 * @param {string} containerName - The name of the container to remove.
 * @returns {Promise<void>}
 */
async function removeContainer(containerName) {
    console.debug(`[Dockerode] Attempting to remove container ${containerName}...`);
    const container = docker.getContainer(containerName);
    try {
        // Attempt to remove, force=true kills if running
        await container.remove({ force: true });
        console.log(`[Dockerode] Container ${containerName} removed.`);
    } catch (error) {
        if (error.statusCode === 404) {
            console.log(`[Dockerode] Container ${containerName} not found, no need to remove.`);
        } else {
            // Log other errors but don't necessarily stop execution? Depends on context.
            console.error(`❌ Error removing container ${containerName}:`, error.message);
            throw error; // Re-throw for now
        }
    }
}

/**
 * Ensures a specific Docker network exists, creating it if necessary.
 * @param {string} clusterId - The cluster ID to incorporate into the network name.
 * @returns {Promise<string>} - The name of the ensured network.
 */
async function ensureNetworkExists(clusterId) {
    const networkName = `asa-network-${clusterId}`;
    console.debug(`[Dockerode] Ensuring network ${networkName} exists...`);
    const network = docker.getNetwork(networkName);
    const inspection = await handleNotFound(network.inspect());

    if (!inspection) {
        console.log(`[Dockerode] Network ${networkName} not found, creating...`);
        try {
            await docker.createNetwork({
                Name: networkName,
                Driver: "bridge",
                Attachable: true // Allows manual attachment later if needed
            });
            console.log(`[Dockerode] Network ${networkName} created.`);
        } catch (error) {
            console.error(`❌ Error creating network ${networkName}:`, error.message);
            // Handle potential race conditions if needed
            const existsNow = await handleNotFound(network.inspect());
            if (!existsNow) throw error; // Creation genuinely failed
            console.warn(`[Dockerode] Network ${networkName} likely created concurrently.`);
        }
    } else {
        console.debug(`[Dockerode] Network ${networkName} already exists.`);
    }
    return networkName;
}

/**
 * Ensures a specific Docker image exists locally, pulling it if necessary.
 * @param {string} imageName - The full name of the image (e.g., 'ubuntu:latest').
 * @returns {Promise<void>}
 */
async function ensureDockerImageExists(imageName) {
    console.debug(`[Dockerode] Ensuring image ${imageName} exists...`);
    const image = docker.getImage(imageName);
    const inspection = await handleNotFound(image.inspect());

    if (!inspection) {
        console.log(`[Dockerode] Image ${imageName} not found, pulling... (This may take time)`);
        try {
            // docker.pull returns a stream to follow progress
            const stream = await docker.pull(imageName, {});
            await new Promise((resolve, reject) => {
                // Use Dockerode's progress handler
                docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res), (event) => {
                    // Log progress events (can be verbose)
                    console.debug(`[Docker Pull][${imageName}] ${event.status} ${event.progress || ''}`);
                });
            });
            console.log(`[Dockerode] Image ${imageName} pulled successfully.`);
        } catch (error) {
            console.error(`❌ Error pulling image ${imageName}:`, error.message);
            throw error;
        }
    } else {
        console.debug(`[Dockerode] Image ${imageName} already exists.`);
    }
}

/**
 * Sets file permissions by running a temporary container to execute chown.
 * Note: This is generally not the recommended way to handle permissions.
 * Consider using Dockerfile USER directive or entrypoint scripts.
 * @async
 * @returns {Promise<void>}
 * @throws {Error} Throws if the temporary container fails or permission setting encounters errors.
 */
async function setPermissions() {
    // Utilise alpine : plus léger
    const imageName = "alpine:latest"; // Use lighter image
    const containerName = "ark-asa-set-permissions-temp"; // Unique temporary name
    console.warn("[Dockerode] Running temporary container for setPermissions if needed - Consider alternatives!");

    await ensureDockerImageExists(imageName);

    const binds = [
        `${path.resolve('./steam')}:/steam:rw`,
        `${path.resolve('./steamcmd')}:/steamcmd:rw`,
        `${path.resolve('./cluster-shared')}:/cluster-shared:rw`,
        `${path.resolve('./server-files')}:/server-files:rw` // Mount the parent server-files directory
    ];

    // Ensure the temporary container doesn't exist from a previous failed run
    await removeContainer(containerName);

    console.debug(`[Dockerode][Permissions] Creating temporary container ${containerName} with alpine...`);
    let tempContainer;
    try {
        tempContainer = await docker.createContainer({
            Image: imageName,
            name: containerName,
             // Alpine uses sh, not bash by default
             // Run chown on the mounted parent directory inside the container
            Cmd: ["chown", "-R", "25000:25000", "/steam", "/steamcmd", "/cluster-shared", "/server-files"],
            User: "root", // Must run as root for chown
            HostConfig: {
                Binds: binds,
                AutoRemove: true // Automatically remove container on exit (requires Docker >= 1.13)
            },
            Tty: false,
            OpenStdin: false
        });

        console.debug(`[Dockerode][Permissions] Starting temporary container ${containerName}...`);
        await tempContainer.start();

        console.debug(`[Dockerode][Permissions] Waiting for temporary container ${containerName} to finish...`);
        const status = await tempContainer.wait();
        console.log(`[Dockerode][Permissions] Temporary container finished with status code: ${status.StatusCode}`);

        if (status.StatusCode !== 0) {
           // Attempt to retrieve logs if the container failed
           let logs = 'Could not retrieve logs.';
           try {
              const logStream = await tempContainer.logs({stdout: true, stderr: true, tail: 100}); // Get last 100 lines
              logs = logStream.toString();
           } catch (logError) {
              console.error(`[Dockerode][Permissions] Could not retrieve logs for failed container ${containerName}: ${logError.message}`);
           }
           throw new Error(`Permissions container failed with status code ${status.StatusCode}. Logs:\n${logs}`);
        }

    } catch (error) {
        console.error(`❌ Error during setPermissions execution:`, error.message);
        // Manual cleanup attempt if AutoRemove is not supported or failed
        if (tempContainer && !(tempContainer.HostConfig?.AutoRemove)) {
             try { await tempContainer.remove({ force: true }); } catch (e) {
                 // Ignore error if already removed
                 if (e.statusCode !== 404) { console.warn(`[Dockerode][Permissions] Could not force remove failed temp container: ${e.message}`); }
             }
         }
        throw error; // Re-throw the original error
    }
    // Note: AutoRemove should handle cleanup. Manual check/removal below might be redundant
    // depending on Docker version and if AutoRemove:true worked.
    finally {
         try {
            // Double check removal, especially if AutoRemove might not be reliable/supported
            const finalCheckContainer = docker.getContainer(containerName);
            await finalCheckContainer.remove({ force: true });
            console.debug(`[Dockerode][Permissions] Ensured cleanup of ${containerName}.`);
         } catch (e) {
            if (e.statusCode !== 404) { // Ignore 404 (already removed)
               console.warn(`[Dockerode][Permissions] Warning: Could not ensure final cleanup of ${containerName}: ${e.message}`);
            } else {
                // This is expected if AutoRemove worked
                 console.debug(`[Dockerode][Permissions] Container ${containerName} already removed.`);
            }
         }
    }
}

/**
 * Checks if host directory permissions match the target UID/GID.
 * @async
 * @param {string[]} dirPaths - Array of absolute host directory paths to check.
 * @param {number} targetUid - The target User ID (e.g., 25000).
 * @param {number} targetGid - The target Group ID (e.g., 25000).
 * @returns {Promise<boolean>} True if all directories exist and have correct ownership, false otherwise.
 */
async function checkPermissions(dirPaths, targetUid, targetGid) {
    console.debug(`[Permissions Check] Verifying ownership for UID=${targetUid}, GID=${targetGid} on paths:`, dirPaths);
    try {
        for (const dirPath of dirPaths) {
            // Check if the path exists first
            try {
                const stats = await fs.stat(dirPath);
                if (stats.uid !== targetUid || stats.gid !== targetGid) {
                    console.warn(`[Permissions Check] Incorrect ownership detected for ${dirPath}: UID=${stats.uid}, GID=${stats.gid}. Expected UID=${targetUid}, GID=${targetGid}.`);
                    return false; // Incorrect permissions found
                }
            } catch (statError) {
                if (statError.code === 'ENOENT') {
                    console.warn(`[Permissions Check] Directory does not exist: ${dirPath}. This might be expected for a new server.`);
                    // If the directory doesn't exist, Docker might create it (as root).
                    // We need setPermissions to run to fix ownership after potential creation.
                    console.warn(`[Permissions Check] Directory ${dirPath} not found. Proceeding to ensure permissions are set via setPermissions.`);
                    return false; // Force setPermissions attempt
                } else {
                    console.error(`[Permissions Check] Error stating directory ${dirPath}:`, statError);
                    return false; // Unknown error, assume permissions are not OK
                }
            }
        }
        console.debug('[Permissions Check] All verified paths exist and have correct ownership.');
        return true; // All checks passed
    } catch (error) {
        console.error("❌ Error during permission check:", error);
        return false; // General error during check
    }
}

/**
 * Creates and starts the main ARK ASA server container.
 * Assumes necessary host directory permissions are already set OR attempts to set them.
 * @async
 * @param {object} server - The server configuration object from config.json.
 * @returns {Promise<Docker.Container>} The Dockerode Container object representing the created and started container.
 * @throws {Error} Throws if container creation or starting fails, or if permission setting fails.
 */
async function createServerContainer(server) {
    server.CLUSTER_ID = server.CLUSTER_ID || generateClusterId(); // Keep previous logic
    const containerName = `ARK-ASA-${server.SERVER_NAME}`;
    const networkName = await ensureNetworkExists(server.CLUSTER_ID);

    console.debug(`[Dockerode] Removing existing container ${containerName} if any...`);
    await removeContainer(containerName); // Ensure clean state

    console.debug(`[Dockerode] Preparing configuration for ${containerName}...`);
    const binds = [
        `${path.resolve(`./server-files/${server.SERVER_NAME}`)}:/home/gameserver/server-files:rw`,
        `${path.resolve(`./steam`)}:/home/gameserver/steam:rw`,
        `${path.resolve(`./steamcmd`)}:/home/gameserver/steamcmd:rw`,
        `${path.resolve(`./cluster-shared`)}:/home/gameserver/cluster-shared:rw`,
        `/etc/localtime:/etc/localtime:ro` // Sync time
    ];

    const portBindings = {
        [`${server.PORT}/udp`]: [{ HostPort: `${server.PORT}` }],
        [`${server.RCON_PORT}/tcp`]: [{ HostPort: `${server.RCON_PORT}` }]
    };

    const envVars = [
        `ASA_START_PARAMS=${server.MAP_NAME}_WP?listen?Port=${server.PORT}?RCONPort=${server.RCON_PORT}?RCONEnabled=True -UseDynamicConfig -WinLiveMaxPlayers=${server.MAX_PLAYERS} -clusterid=${server.CLUSTER_ID} -ClusterDirOverride="/home/gameserver/cluster-shared" -mods=${server.MODS}`,
        `ENABLE_DEBUG=0` // Consider making this configurable
    ];

    // Base image - consider making configurable
    const imageName = "mschnitzer/asa-linux-server:latest";

    const containerConfig = {
        Image: imageName,
        name: containerName, // Set name for easy reference
        Hostname: containerName,
        User: "gameserver", // Ensure this user exists in the image with correct permissions
        Tty: true, // Often required for game servers
        OpenStdin: true, // Often required with Tty
        Env: envVars,
        HostConfig: {
            Binds: binds,
            PortBindings: portBindings,
            NetworkMode: networkName
            // AutoRemove: false // Default, don't remove on stop
        },
        Entrypoint: ["/usr/bin/start_server"],
    };

    console.debug(`[Dockerode] Ensuring base image ${imageName} exists...`);
    await ensureDockerImageExists(imageName);

    // --- Start of Permission Check and Set ---
    const targetUid = 25000;
    const targetGid = 25000;
    // Build the list of absolute host paths to check/fix
    // We need to check all paths that will be mounted AND that the 'gameserver' user needs to write to.
    // Including the parent ./server-files might be needed if ARK writes logs outside its specific dir initially?
    // Let's check the essential ones first.
     const hostPathsToCheck = [
        path.resolve('./steam'), // Assume steam user (often root or specific UID) writes here, but check anyway? Maybe not needed. Let's focus on game server dirs.
        path.resolve('./steamcmd'), // Same as steam.
        path.resolve('./cluster-shared'), // ARK server (25000) needs to write here.
        path.resolve(`./server-files/${server.SERVER_NAME}`) // ARK server (25000) definitely needs to write here.
    ];

    console.log(`[Permissions] Checking ownership for server ${server.SERVER_NAME}...`);
    // Check permissions on the required writable directories
    const permissionsOk = await checkPermissions(hostPathsToCheck, targetUid, targetGid);

    if (!permissionsOk) {
        console.warn(`[Permissions] Ownership incorrect or check failed for ${server.SERVER_NAME}. Attempting to set permissions via temporary container...`);
        try {
            // Run the temporary chown container only if needed
            // It chowns the parent ./server-files, which implicitly fixes the specific dir if it exists,
            // and handles the case where Docker created the specific dir as root.
            await setPermissions();
        } catch (permError) {
            console.error(`❌ FATAL: Failed to set permissions for ${server.SERVER_NAME}. Cannot start container safely.`, permError);
            // Crucial to stop here, otherwise the ARK container will likely fail.
            throw new Error(`Failed to set necessary volume permissions for ${server.SERVER_NAME}. Please check logs and host permissions.`);
        }
    } else {
        console.log(`[Permissions] Ownership verified for ${server.SERVER_NAME}. Skipping setPermissions.`);
    }
    // --- End of Permission Check and Set ---


    console.log(`[Dockerode] Creating container ${containerName}...`);
    const container = await docker.createContainer(containerConfig);

    console.log(`[Dockerode] Starting container ${containerName}...`);
    await container.start();
    console.log(`[Dockerode] Container ${containerName} started.`);

    return container; // Return the Dockerode container object
}

/**
 * Executes the full start sequence for a server by name.
 * Fetches server config before creating and starting the container.
 * @param {string} serverName - The name of the server from config.
 * @returns {Promise<void>}
 * @throws {Error} If the server config is not found or container start fails.
 */
async function executeStartServer(serverName) { // Reçoit toujours serverName
    console.log(`[Service] Attempting to start server: ${serverName}`);

    // ===> AJOUT : Récupérer la configuration complète du serveur <===
    const server = await findServerByName(serverName); // Appel au modèle
    if (!server) {
        // Loggue l'erreur et lance une exception pour que le contrôleur la gère
        console.error(`[Service][Error] Server configuration for '${serverName}' not found in executeStartServer.`);
        throw new Error(`Server ${serverName} not found in configuration.`);
    }
    // On pourrait aussi vérifier server.ENABLED ici si on voulait centraliser la logique

    try {
        // Maintenant, on passe l'objet 'server' complet à createServerContainer
        await createServerContainer(server);
        console.log(`[Service] Server ${serverName} container created and start initiated successfully.`);
    } catch (error) {
        console.error(`❌ Failed to execute start sequence for server ${serverName}:`, error.message, error.stack);
        // Propager l'erreur pour que le contrôleur puisse renvoyer une réponse 500
        throw error;
    }
}

/**
 * Stops a running server container.
 * @param {string} serverName - The name of the server.
 * @returns {Promise<void>}
 * @throws {Error} If stopping the container fails (excluding 'not found' or 'already stopped' errors).
 */
async function executeStopServer(serverName) {
    const containerName = `ARK-ASA-${serverName}`;
    console.log(`[Service] Attempting to stop server: ${serverName} (${containerName})`);
    try {
        const container = docker.getContainer(containerName);
        console.log(`[Dockerode] Stopping container ${containerName}...`);
        // Default stop timeout is 10 seconds, can be adjusted: container.stop({ t: 30 }, callback)
        await container.stop();
        console.log(`[Dockerode] Container ${containerName} stopped.`);
        // Optional: Remove container after stop if desired:
        // console.log(`[Dockerode] Removing container ${containerName}...`);
        // await container.remove();
        // console.log(`[Dockerode] Container ${containerName} removed.`);
    } catch (error) {
         // Gracefully handle common non-fatal errors during stop
         if (error.statusCode === 404) { // Container doesn't exist
            console.warn(`[Dockerode] Container ${containerName} not found while trying to stop.`);
         } else if (error.statusCode === 304) { // Container already stopped
             console.warn(`[Dockerode] Container ${containerName} was already stopped.`);
         } else { // Log and re-throw other errors
            console.error(`❌ Error stopping container ${containerName}:`, error.message);
            throw error;
         }
    }
}

/**
 * Restarts a server container.
 * @param {string} serverName - The name of the server.
 * @returns {Promise<void>}
 * @throws {Error} If restarting fails (excluding 'not found' error).
 */
async function executeRestartServer(serverName) {
    const containerName = `ARK-ASA-${serverName}`;
    console.log(`[Service] Attempting to restart server: ${serverName} (${containerName})`);
    try {
        const container = docker.getContainer(containerName);
        console.log(`[Dockerode] Restarting container ${containerName}...`);
        // Default restart timeout is 10 seconds
        await container.restart();
        console.log(`[Dockerode] Container ${containerName} restart command issued.`);
    } catch (error) {
         if (error.statusCode === 404) { // Container doesn't exist
            console.warn(`[Dockerode] Container ${containerName} not found while trying to restart.`);
            // Should we try to start it instead? Or just report error?
            throw new Error(`Cannot restart ${serverName}: container not found.`);
         } else { // Log and re-throw other errors
            console.error(`❌ Error restarting container ${containerName}:`, error.message);
            throw error;
         }
    }
}

/**
 * Gets a readable stream of a container's logs (stdout & stderr).
 * Assumes TTY=true for combined output, decodes to UTF8.
 * @param {string} containerName - The name of the container.
 * @returns {Promise<ReadableStream>} - A readable stream emitting UTF8 log lines.
 * @throws {Error} If the container is not found or log streaming fails.
 */
async function streamDockerLogs(containerName) {
    console.debug(`[Dockerode] Requesting log stream for ${containerName}...`);
    try {
        const container = docker.getContainer(containerName);
        const logStream = await container.logs({
            stdout: true,
            stderr: true,
            follow: true, // Stream logs continuously
            tail: 50 // Get last 50 lines on connection
        });
         console.debug(`[Dockerode] Raw log stream obtained for ${containerName}.`);

         // Pipe through PassThrough to ensure standard Node stream and decode UTF8
         const passThrough = new PassThrough({ encoding: 'utf8' });
         // Dockerode streams can be Buffer objects
         logStream.on('data', (chunk) => {
            // Ensure chunk is decoded to UTF8 string
             passThrough.write(chunk.toString('utf8'));
         });
         logStream.on('end', () => passThrough.end());
         logStream.on('error', (err) => passThrough.emit('error', err)); // Propagate errors

         console.debug(`[Dockerode] Returning decoded log stream for ${containerName}.`);
         return passThrough;

    } catch (error) {
        console.error(`❌ Error getting log stream for ${containerName}:`, error.message);
        // Handle 404 specifically if needed
        if (error.statusCode === 404) {
           console.warn(`[Dockerode] Container ${containerName} not found for log streaming.`);
        }
        throw error; // Propagate error
    }
}

/*=======================================================================
 * STREAMING STATS (Refactored with Dockerode - returns processed data stream)
 *======================================================================*/

/**
 * Calculates CPU usage percentage from Docker stats object.
 * Handles missing pre-stats data on the first tick.
 * @param {object} stats - The Docker stats object.
 * @returns {number} - CPU usage percentage.
 */
function calculateCPUPercentage(stats) {
    try {
        // Check if necessary stats are present
        if (!stats || !stats.cpu_stats?.cpu_usage?.total_usage || !stats.precpu_stats?.cpu_usage?.total_usage || !stats.cpu_stats?.system_cpu_usage || !stats.precpu_stats?.system_cpu_usage) {
            // console.warn("[CPU Calc] Insufficient stats data for calculation.");
            return 0.0;
        }

        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;

        // Determine number of CPUs
        let cpuCount = os.cpus().length; // Fallback
        if (stats.cpu_stats.online_cpus) {
            cpuCount = stats.cpu_stats.online_cpus;
        } else if (stats.cpu_stats.cpu_usage.percpu_usage) {
            cpuCount = stats.cpu_stats.cpu_usage.percpu_usage.length;
        }

        if (systemDelta > 0.0 && cpuDelta >= 0.0 && cpuCount > 0) { // Allow cpuDelta to be 0
            return (cpuDelta / systemDelta) * cpuCount * 100.0;
        }
        return 0.0;
    } catch (e) {
        console.error("❌ Error calculating CPU percentage:", e);
        return 0.0;
    }
}


/**
 * Gets a readable stream of processed container stats (CPU %, Memory usage).
 * The stream emits objects: { type: 'stats', serverName, containerId, cpu, memory: { used, total }, timestamp }
 * @param {string} containerId - The ID of the container.
 * @param {string} serverName - The logical name of the server (for context).
 * @returns {Promise<ReadableStream>} - An object-mode readable stream emitting processed stats.
 */
async function streamContainerStats(containerId, serverName) {
    console.debug(`[Dockerode][STREAM] Initializing stats stream for container ${containerId} (Server: ${serverName})`);
    // Create an object-mode stream to emit processed data
    const dataStream = new PassThrough({ objectMode: true });

    try {
        const container = docker.getContainer(containerId);
        // Request the stats stream, Dockerode should parse JSON
        const rawStatsStream = await container.stats({ stream: true });
        console.debug(`[Dockerode][STREAM] Raw stats stream obtained for ${serverName}.`);

        rawStatsStream.on('data', (statsChunk) => {
            // Assuming statsChunk is already a parsed JSON object from Dockerode v3+
            const stats = statsChunk;
            // Basic validation of the received object
            if (!stats || typeof stats !== 'object' || !stats.read) {
                // Skip potentially empty or invalid chunks (e.g., first chunk)
                return;
            }

            const cpuPercent = calculateCPUPercentage(stats);
            const memUsage = stats.memory_stats?.usage || 0;
            const memLimit = stats.memory_stats?.limit || 1; // Avoid division by zero if limit is 0

            // Emit a structured data object
            dataStream.write({
                type: 'stats', // Indicate data type
                serverName: serverName,
                containerId: containerId,
                cpu: parseFloat(cpuPercent.toFixed(1)), // Keep as number, 1 decimal place
                memory: {
                    used: memUsage, // Bytes
                    total: memLimit // Bytes
                },
                timestamp: stats.read // ISO timestamp from Docker stats
            });
        });

        rawStatsStream.on('error', (err) => {
            console.error(`❌ [Dockerode][STATS ERR][${serverName}] Error on raw stats stream:`, err.message);
            dataStream.emit('error', new Error(`Raw stats stream error for ${serverName}: ${err.message}`));
            dataStream.end();
        });

        rawStatsStream.on('end', () => {
            console.log(`[Dockerode][STREAM][${serverName}] Raw stats stream ended.`);
            dataStream.end(); // End the processed data stream
        });

        return dataStream; // Return the stream emitting processed objects

    } catch (err) {
        console.error(`❌ [Dockerode][STATS INIT ERR][${serverName}] Failed to initialize stats stream for ${containerId}:`, err.message);
        // Ensure the returned stream emits the error and ends if init fails
        setImmediate(() => { // Emit error on next tick after returning stream
            dataStream.emit('error', new Error(`Stats stream init error for ${serverName}: ${err.message}`));
            dataStream.end();
        });
        return dataStream;
    }
}

/**
 * Initiates stats streaming for all currently running ARK-ASA containers.
 * Returns an array of readable streams, each emitting processed stats objects.
 * The caller is responsible for consuming these streams.
 * @returns {Promise<ReadableStream[]>} - A promise resolving to an array of object-mode streams.
 */
async function startStatsStreamingForAllContainers() {
    console.log("[Dockerode] Initiating stats streaming for all relevant running containers...");
    let validStreams = [];
    try {
        const containers = await listContainers(false); // Only running containers

        if (!containers || containers.length === 0) {
            console.log("[Dockerode] No running containers found to initiate stats streaming.");
            return [];
        }

        // Use Promise.allSettled to handle potential errors for individual streams
        const streamPromises = containers
            .map(containerInfo => {
                const containerName = containerInfo.Names && containerInfo.Names.length > 0
                    ? containerInfo.Names[0].substring(1) // Remove leading '/'
                    : null;

                if (containerName && containerName.startsWith('ARK-ASA-')) {
                    const serverName = containerName.replace('ARK-ASA-', '');
                    console.debug(`[Dockerode][STREAM INIT] Found ${containerName}. Initiating stream.`);
                    // Return the promise which will resolve to the stream or throw an error
                    return streamContainerStats(containerInfo.Id, serverName)
                        .then(stream => ({ status: 'fulfilled', value: stream, serverName })) // Wrap success
                        .catch(error => ({ status: 'rejected', reason: error, serverName })); // Wrap error
                }
                return null; // Ignore non-ARK containers
            })
            .filter(p => p !== null); // Filter out nulls

        const results = await Promise.allSettled(streamPromises);

        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value && result.value.status === 'fulfilled') {
                validStreams.push(result.value.value); // Add the stream to the list
            } else if (result.status === 'fulfilled' && result.value && result.value.status === 'rejected') {
                 // Handle error from the inner promise caught by the wrapper
                 console.error(`❌ [Dockerode][STREAM INIT ERR][${result.value.serverName}] Failed to initiate stream: ${result.value.reason.message}`);
            } else if (result.status === 'rejected') {
                // Handle error from Promise.allSettled itself (less likely here)
                console.error(`❌ Error processing stream promise: ${result.reason}`);
            }
        });

        console.log(`[Dockerode] Stats streaming initiated. Returning ${validStreams.length} valid streams. Consumption needed elsewhere.`);
        return validStreams;

    } catch (err) {
        console.error("❌ Error listing containers in startStatsStreamingForAllContainers:", err.message);
        return []; // Return empty array on major failure
    }
}


// --- generateClusterId remains unchanged ---
/**
 * Generates a UUID v4 string for cluster IDs.
 * @returns {string} A randomly generated UUID.
 */
function generateClusterId() {
    // Basic UUID v4 generation
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}


/**
 * Executes a command inside a running container using dockerode.exec.
 * @param {string} containerName - The name or ID of the target container.
 * @param {string[]} commandArray - The command and its arguments as an array.
 * @param {string} [user=''] - The user to run the command as.
 * @param {boolean} [allocateTty=true] - Whether to allocate a pseudo-TTY (defaults to true based on user command).
 * @returns {Promise<string>} - A promise resolving to the stdout of the command.
 * @throws {Error} If execution fails.
 */
async function executeCommandInContainer(containerName, commandArray, user = '', allocateTty = true) { // Ajout du paramètre allocateTty
    console.log(`[Docker Service][Exec][${containerName}] Running command: ${commandArray.join(' ')} as user '${user || 'default'}' (TTY: ${allocateTty})`);
    let stderrOutput = ''; // Pour stocker stderr si TTY = false

    try {
        const container = docker.getContainer(containerName);
        // const inspection = await handleNotFound(container.inspect()); // Vérif existence optionnelle
        // if (!inspection || !inspection.State.Running) throw new Error(...);

        const execOptions = {
            Cmd: commandArray,
            User: user,
            AttachStdout: true,
            AttachStderr: !allocateTty, // N'attache stderr que si TTY est false (sinon il est multiplexé sur stdout)
            Tty: allocateTty // Utilise le paramètre
        };

        const exec = await container.exec(execOptions);
        const stream = await exec.start({ hijack: true, stdin: false, tty: allocateTty }); // Informe start aussi
        console.debug(`[RCON Service][${containerName}] Exec stream started (TTY: ${allocateTty}).`);

        let output = '';

        // Gestion différente du flux si TTY est activé ou non
        if (allocateTty) {
            // Avec TTY=true, stdout et stderr sont combinés dans le flux unique 'stream'
            stream.on('data', (chunk) => {
                output += chunk.toString('utf8');
            });
        } else {
            // Sans TTY, Docker peut multiplexer. Utiliser le démultiplexeur.
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            docker.modem.demuxStream(stream, stdout, stderr);
            stdout.on('data', (chunk) => output += chunk.toString('utf8'));
            stderr.on('data', (chunk) => stderrOutput += chunk.toString('utf8')); // Capture stderr séparément
        }

        // Attendre la fin du flux principal
        await new Promise((resolve, reject) => {
            stream.on('end', resolve);
            stream.on('error', reject);
        });
        console.debug(`[RCON Service][${containerName}] Exec stream ended.`);

        // Vérifier le résultat
        const inspectResult = await exec.inspect();
        if (inspectResult.ExitCode !== 0) {
            // Si erreur, inclure stderr si disponible, sinon stdout
            const errorDetails = (!allocateTty && stderrOutput) ? stderrOutput.trim() : output.trim();
            console.error(`[Docker Service][Exec][${containerName}] Failed. ExitCode: ${inspectResult.ExitCode}, Output/Stderr: ${errorDetails}`);
            throw new Error(`Command "${commandArray.join(' ')}" failed with exit code ${inspectResult.ExitCode}: ${errorDetails}`);
        }

        // Logguer stderr comme avertissement même si succès (si TTY=false)
        if (!allocateTty && stderrOutput) {
             console.warn(`[Docker Service][Exec][${containerName}] Command stderr: ${stderrOutput.trim()}`);
        }

        console.log(`[Docker Service][Exec][${containerName}] Command successful.`);
        return output.trim();

    } catch (error) {
        // ... (gestion des erreurs comme avant) ...
         console.error(`❌ [Docker Service][Exec][${containerName}] Error executing command "${commandArray.join(' ')}":`, error.message);
         if (error.statusCode === 404) { throw new Error(`Container ${containerName} not found for exec.`); }
         throw error;
    }
}


/*=======================================================================
 * EXPORTS
 *======================================================================*/

module.exports = {
    executeCommandInContainer,
    executeStartServer,
    executeStopServer,
    executeRestartServer,
    checkContainerExists,
    removeContainer,
    setWebSocketInstance, // Kept for potential external use or interface consistency
    streamDockerLogs,
    listContainers,
    streamContainerStats, // Exports the function returning the processed data stream
    startStatsStreamingForAllContainers // Exports the function returning array of streams
    // Internal functions like ensure*, setPermissions, createServerContainer are not exported
};