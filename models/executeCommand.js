const { exec } = require("child_process");

/**
 * Exécute une commande shell et retourne une promesse.
 * @param {string} command - La commande à exécuter.
 * @returns {Promise<string>} - Résultat de la commande.
 */
function executeCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error executing command: ${command}`, error);
                reject(error);
            } else if (stderr) {
                console.warn(`Command warning: ${command}`, stderr);
                resolve(stderr);
            } else {
                resolve(stdout);
            }
        });
    });
}

module.exports = { executeCommand };
