const fs = require("fs");
const http = require('http');
const os = require('os');
const { execSync } = require("child_process");
const path = require("path");
const configPath = path.join(__dirname, "..", "config", "config.json");
const { findServerByName } = require("../models/serverModel");
const monitorsService = require('./monitorsService');

/*=======================================================================
 *                      PERMISSIONS & CLUSTER UTILITIES
 *======================================================================*/

/**
 * Runs the Docker container that sets the necessary file permissions
 * before launching an Ark server.
 * 
 * This uses the `setPermission.yml` file to adjust permissions.
 * The container exits automatically after execution.
 * 
 * @throws {Error} If the command fails.
 */
function runSetPermissions() {
    try {
        console.log("🛠 Running permission setup before launching the server...");

        const permissionComposePath = path.join(__dirname, "..", "compose-files", "setPermission.yml");

        // Execute the Docker Compose command
        execSync(`docker-compose -f ${permissionComposePath} up --force-recreate`, { stdio: "inherit" });

        console.log("✅ Permissions setup completed successfully.");
    } catch (error) {
        console.error("❌ Error while setting up permissions:", error);
        throw new Error("Failed to set up permissions.");
    }
}

/**
 * Generates a unique cluster ID if not provided.
 * @returns {string} A randomly generated cluster ID.
 */
function generateClusterId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

/*=======================================================================
 *                      DOCKER COMPOSE FILE GENERATION
 *======================================================================*/

/**
 * Generates a Docker Compose YAML file for a given server.
 * 
 * @param {Object} server - The server configuration object.
 * @returns {void}
 * @throws {Error} If reading or writing the YAML file fails.
 */
function generateDockerComposeFile(server) {
    try {
        const clusterId = server.CLUSTER_ID || generateClusterId(); // Ensure a cluster ID exists

        const yamlTemplatePath = path.join(__dirname, "..", "compose-files", "template.yml");
        const yamlOutputPath = path.join(__dirname, "..", "compose-files", `${server.SERVER_NAME}-${server.MAP_NAME}.yml`);

        // Read the template file
        fs.readFile(yamlTemplatePath, "utf8", (err, data) => {
            try {
                if (err) {
                    console.error("Error reading the YAML template:", err);
                    throw err;
                }

                // Replace placeholders with actual values
                const yamlContent = data
                    .replace(/\${SERVER_NAME}/g, server.SERVER_NAME)
                    .replace(/\${MAP_NAME}/g, server.MAP_NAME + "_WP")
                    .replace(/\${PORT}/g, server.PORT)
                    .replace(/\${RCON_PORT}/g, server.RCON_PORT)
                    .replace(/\${MAX_PLAYERS}/g, server.MAX_PLAYERS)
                    .replace(/\${CLUSTER_ID}/g, clusterId)
                    .replace(/\${MODS}/g, server.MODS || "");

                // Write the new YAML file
                fs.writeFile(yamlOutputPath, yamlContent, "utf8", (err) => {
                    try {
                        if (err) {
                            console.error("Error writing Docker Compose YAML file:", err);
                            throw err;
                        } else {
                            console.log(`Docker Compose file generated: ${yamlOutputPath}`);
                        }
                    } catch (err) {
                        throw err;
                    }
                });

            } catch (err) {
                throw err;
            }
        });

    } catch (err) {
        console.error("An error occurred in generateDockerComposeFile:", err);
        throw err;
    }
}

/*=======================================================================
 *                           DOCKER SERVER ACTIONS
 *======================================================================*/

/**
 * Generates the Docker Compose file and starts the Ark server.
 * 
 * @param {string} serverName - The name of the server to start.
 * @returns {Promise<void>}
 * @throws {Error} If Docker fails to start the server.
 */
async function executeStartServer(serverName) {
    console.log(serverName);
    try {
        // Run permissions setup before starting the server
        runSetPermissions();

        const server = findServerByName(serverName);

        if (!server) {
            console.error("Server not found");
        }

        // Generate the Docker Compose file
        await generateDockerComposeFile(server);

        const dockerComposePath = path.join(__dirname, "..", "compose-files", `${server.SERVER_NAME}-${server.MAP_NAME}.yml`);

        console.log(`🚀 Starting Ark server: ${server.SERVER_NAME} (${server.MAP_NAME})`);

        // Start the Docker container for the server
        execSync(`docker-compose -f ${dockerComposePath} up -d`, { stdio: "inherit" });

        console.log(`✅ Server ${server.SERVER_NAME} started successfully.`);
    } catch (error) {
        console.error(`❌ Failed to start server ${serverName}:`, error);
        throw new Error(`Failed to start server ${serverName}`);
    }
}

/**
 * Stops a running ASA server container.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {void}
 */
function executeStopServer(serverName) {
    try {
        const containerName = `ARK-ASA-${serverName}`;
        console.log(`[DOCKER] Stopping server: ${serverName}`);
        execSync(`docker stop ${containerName}`);
    } catch (error) {
        console.error(`[ERROR] Failed to stop server ${serverName}:`, error.message);
    }
}

/**
 * Restarts a server by stopping and starting it again.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {Promise<void>}
 */
async function executeRestartServer(serverName) {
    await executeStopServer(serverName);
    return executeStartServer(serverName);
}

/**
 * Checks the running status of the server's Docker container.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {string} Server status: 'off' or 'running'.
 */
function isServerRunning(serverName) {
    try {
        const containerName = `ARK-ASA-${serverName}`;
        const result = execSync(`docker ps --filter "name=${containerName}" --format "{{.Names}}"`).toString().trim();

        if (result) {
            return "running";
        } else {
            return "off";
        }
    } catch (err) {
        console.error(`❌ Error checking server status for ${serverName}:`, err.message);
        return "off";
    }
}

/**
 * Returns global Docker and host stats (CPU, Memory)
 * @returns {Object} Host stats
 */
async function getDockerStats() {
    try {
        const containers = await listContainers();
        const statsPromises = containers.map(container =>
            getContainerStats(container.Id)
        );
        const containersStatsRaw = await Promise.all(statsPromises);

        let totalCPU = 0;
        const containersStats = {};

        containersStatsRaw.forEach((stat, index) => {
            const cpuPercent = calculateCPUPercentage(stat);
            totalCPU += cpuPercent;

            // Memory calculation
            const memUsage = stat.memory_stats.usage || 0;
            const memLimit = stat.memory_stats.limit || 1; // Avoid division by 0
            const memPercent = (memUsage / memLimit) * 100;

            containersStats[containers[index].Id] = {
                name: containers[index].Names[0].replace('/', ''), // Clean name
                CPU_USAGE: `${cpuPercent.toFixed(2)}%`,
                MEMORY_USAGE: `${memPercent.toFixed(2)}%`
            };
        });

        // Host memory (as before)
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const memUsagePercent = ((usedMem / totalMem) * 100).toFixed(2);

        return {
            CPU_USAGE: `${totalCPU.toFixed(2)}%`,
            MEMORY_USAGE: `${memUsagePercent}%`,
            containersStats
        };

    } catch (err) {
        console.error("❌ Error in getDockerStats:", err.message);
        return { CPU_USAGE: "N/A", MEMORY_USAGE: "N/A", containersStats: {} };
    }
}

/**
 * Lists running Docker containers
 * @returns {Promise<Array>} Containers array
 */
function listContainers() {
    return new Promise((resolve, reject) => {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: '/containers/json',
            method: 'GET'
        };
        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const containers = JSON.parse(data);
                    resolve(containers);
                } catch (e) {
                    reject(new Error('Invalid JSON from Docker API'));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Gets stats for a specific Docker container
 * @param {string} containerId
 * @returns {Promise<Object>} Container stats
 */
function getContainerStats(containerId) {
    return new Promise((resolve, reject) => {
        const options = {
            socketPath: '/var/run/docker.sock',
            path: `/containers/${containerId}/stats?stream=false`,
            method: 'GET'
        };
        const req = http.request(options, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const stats = JSON.parse(data);
                    resolve(stats);
                } catch (e) {
                    reject(new Error(`Invalid stats JSON for container ${containerId}`));
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Calculates CPU usage percentage from container stats
 * @param {Object} stats
 * @returns {number} CPU usage percentage
 */
function calculateCPUPercentage(stats) {
    try {
        const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
        const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
        const cpuCount = stats.cpu_stats.online_cpus || os.cpus().length;
        if (systemDelta > 0 && cpuDelta > 0) {
            return (cpuDelta / systemDelta) * cpuCount * 100;
        }
        return 0;
    } catch (err) {
        console.warn(`⚠️ Failed to calculate CPU usage: ${err.message}`);
        return 0;
    }
}


/*=======================================================================
 *                            EXPORTS
 *======================================================================*/

module.exports = {
    generateClusterId,
    generateDockerComposeFile,
    executeStartServer,
    executeStopServer,
    executeRestartServer,
    isServerRunning,
    getDockerStats,
};
