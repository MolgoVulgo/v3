/**
 * @fileoverview Model for handling server configuration data (CRUD operations).
 * Reads from and writes to configServer.json.
 * @version 2.0.0 Added write operations, uses configServer.json.
 */

const fs = require('fs').promises; // Utilise la version promesse de fs
const path = require('path');

// Chemin vers le fichier de configuration des serveurs
const configPath = path.join(__dirname, "../config/configServer.json");

/**
 * Reads the server configuration file.
 * @returns {Promise<object>} The parsed configuration object { SERVERS: [...] }.
 * @throws {Error} If the file cannot be read or parsed.
 */
async function readConfigFile() {
    try {
        const rawData = await fs.readFile(configPath, "utf8");
        return JSON.parse(rawData);
    } catch (error) {
        // Si le fichier n'existe pas, on peut retourner une structure vide
        if (error.code === 'ENOENT') {
            console.warn(`[ServerModel] Config file not found at ${configPath}. Returning empty structure.`);
            return { SERVERS: [] };
        }
        console.error(`[ServerModel] Error reading config file ${configPath}:`, error);
        throw new Error(`Failed to read server configuration: ${error.message}`);
    }
}

/**
 * Writes the server list to the configuration file.
 * @param {object[]} servers - The array of server configuration objects to save.
 * @returns {Promise<void>}
 * @throws {Error} If the file cannot be written.
 */
async function writeConfigFile(servers) {
    try {
        const dataToWrite = JSON.stringify({ SERVERS: servers }, null, 2); // Pretty print JSON
        await fs.writeFile(configPath, dataToWrite, "utf8");
        console.log(`[ServerModel] Server configuration saved to ${configPath}`);
    } catch (error) {
        console.error(`[ServerModel] Error writing config file ${configPath}:`, error);
        throw new Error(`Failed to save server configuration: ${error.message}`);
    }
}

/**
 * Retrieves the list of all servers from the configuration file.
 * @returns {Promise<object[]>} A promise resolving to the list of server objects.
 */
async function loadServersConfig() {
    const config = await readConfigFile();
    return config.SERVERS || [];
}

/**
 * Retrieves a specific server by its name from the configuration file.
 * @param {string} serverName - The name of the server to retrieve.
 * @returns {Promise<object|null>} A promise resolving to the server object if found, otherwise null.
 */
async function findServerByName(serverName) {
    const servers = await loadServersConfig();
    return servers.find(s => s.SERVER_NAME === serverName) || null;
}

/**
 * Adds a new server configuration. Handles port allocation and uniqueness checks.
 * @param {object} newServerData - The data for the new server (SERVER_NAME, MAP_NAME, MAX_PLAYERS, MODS, CLUSTER_ID, ENABLED).
 * PORT and RCON_PORT will be allocated.
 * @returns {Promise<object>} A promise resolving to the newly added server object (with allocated ports).
 * @throws {Error} If server name already exists or save fails.
 */
async function addServerConfig(newServerData) {
    const servers = await loadServersConfig();

    // 1. Check for unique name
    if (servers.some(server => server.SERVER_NAME === newServerData.SERVER_NAME)) {
        throw new Error(`Server name "${newServerData.SERVER_NAME}" already exists. SERVER_NAME must be unique.`);
    }

    // 2. Ensure map name format (optional, based on previous logic)
    if (newServerData.MAP_NAME && !newServerData.MAP_NAME.endsWith("_WP")) {
        newServerData.MAP_NAME += "_WP";
    }

    // 3. Allocate Ports
    const basePort = parseInt(process.env.BASE_PORT || "7777", 10);
    const baseRconPort = parseInt(process.env.BASE_RCON_PORT || "27020", 10);
    let newPort = basePort;
    let newRconPort = baseRconPort;

    const usedPorts = new Set(servers.map(s => s.PORT));
    const usedRconPorts = new Set(servers.map(s => s.RCON_PORT));

    // Find next available game port
    while (usedPorts.has(newPort)) {
        newPort++;
    }
    // Find next available RCON port
    while (usedRconPorts.has(newRconPort)) {
        newRconPort++;
    }

    // 4. Assemble final server object
    const finalNewServer = {
        ...newServerData,
        PORT: newPort,
        RCON_PORT: newRconPort,
        ENABLED: newServerData.ENABLED !== undefined ? newServerData.ENABLED : true // Default to enabled
    };

    // 5. Add to list and save
    servers.push(finalNewServer);
    await writeConfigFile(servers);

    return finalNewServer; // Return the added server with allocated ports
}

/**
 * Updates an existing server configuration by name.
 * @param {string} serverName - The name of the server to update.
 * @param {object} updatedServerData - An object containing the properties to update.
 * @returns {Promise<object>} A promise resolving to the updated server object.
 * @throws {Error} If the server is not found or save fails.
 */
async function updateServerConfig(serverName, updatedServerData) {
    const servers = await loadServersConfig();
    const serverIndex = servers.findIndex(s => s.SERVER_NAME === serverName);

    if (serverIndex === -1) {
        throw new Error(`Server "${serverName}" not found for update.`);
    }

    // Merge updates, ensuring crucial fields are not accidentally removed
    // We don't update PORT or RCON_PORT here, only other fields. Name shouldn't change either.
    const originalServer = servers[serverIndex];
    servers[serverIndex] = {
        ...originalServer, // Keep original PORT, RCON_PORT, SERVER_NAME
        ...updatedServerData, // Apply updates
        SERVER_NAME: originalServer.SERVER_NAME, // Ensure name cannot be changed via update
        PORT: originalServer.PORT, // Ensure port cannot be changed via update
        RCON_PORT: originalServer.RCON_PORT // Ensure RCON port cannot be changed via update
    };

    await writeConfigFile(servers);
    return servers[serverIndex]; // Return the updated server object
}

/**
 * Deletes a server configuration by name.
 * @param {string} serverName - The name of the server to delete.
 * @returns {Promise<void>}
 * @throws {Error} If the server is not found or save fails.
 */
async function deleteServerConfig(serverName) {
    let servers = await loadServersConfig();
    const initialLength = servers.length;
    servers = servers.filter(server => server.SERVER_NAME !== serverName);

    if (servers.length === initialLength) {
        throw new Error(`Server "${serverName}" not found for deletion.`);
    }

    await writeConfigFile(servers);
}


module.exports = {
    loadServersConfig,
    findServerByName,
    addServerConfig,
    updateServerConfig,
    deleteServerConfig,
    // readConfigFile and writeConfigFile are internal, no need to export usually
};