const fs = require("fs");
const path = require("path");
const configPath = path.join(__dirname, "../config/config.json");

/**
 * Retrieves a specific server by its name from the configuration file.
 * 
 * @param {string} serverName - The name of the server to retrieve.
 * @returns {Object|null} The server object if found, otherwise null.
 */
function findServerByName(serverName) {
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        return config.SERVERS.find(s => s.SERVER_NAME === serverName) || null;
    } catch (error) {
        console.error("Error fetching server:", error);
        return null;
    }
}

module.exports = { findServerByName };
