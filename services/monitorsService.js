const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const uiService = require("./uiService");
const dockerService = require("./dockerService");

const shooterGameKeywords = require("../config/ShooterGameKeyword.json");
const dockerKeywords = require("../config/dockerKeyword.json");

const activeMonitors = {}; // Store active monitoring processes

/*=======================================================================
 *                         MONITORING FUNCTIONS
 *======================================================================*/

/**
 * Monitors Docker logs until the server has completed the Steam setup.
 * 
 * @param {string} serverName - Name of the server.
 * @param {Function} callback - Function called when a keyword is found or timeout occurs.
 * @returns {void}
 */
function monitorDockerLogs(serverName, callback) {
    const containerName = `ARK-ASA-${serverName}`;
    const dockerLogs = spawn("docker", ["logs", "-f", containerName]);

    let timeout = setTimeout(() => {
        dockerLogs.kill();
        callback("timeout");
    }, 60000); // 1 min timeout if no keyword is found

    dockerLogs.stdout.on("data", (data) => {
        const log = data.toString();

        dockerKeywords.forEach(({ keyword, state }) => {
            if (log.includes(keyword)) {
                clearTimeout(timeout);
                dockerLogs.kill();
                callback(state);
            }
        });
    });

    dockerLogs.stderr.on("data", (data) => {
        console.error(`[DOCKER ERROR] ${serverName}:`, data.toString());
    });

    dockerLogs.on("exit", (code) => {
        console.log(`[DOCKER MONITOR] ${serverName} exited with code ${code}`);
    });

    activeMonitors[serverName] = dockerLogs;
}

/**
 * Monitors ShooterGame.log file to check if server startup is complete.
 * 
 * @param {string} serverName - Name of the server.
 * @param {Function} callback - Function called when a keyword is found or timeout occurs.
 * @returns {void}
 */
function monitorShooterGameLog(serverName, callback) {
    const logFilePath = path.join(__dirname, "..", "server-files", serverName, "ShooterGame", "Saved", "Logs", "ShooterGame.log");

    if (!fs.existsSync(logFilePath)) {
        console.warn(`[WARNING] Log file not found: ${logFilePath}`);
        return callback("error");
    }

    const logStream = spawn("tail", ["-n", "10", "-f", logFilePath]);

    let timeout = setTimeout(() => {
        logStream.kill();
        callback("timeout");
    }, 300000); // 5 min timeout if startup is not completed

    logStream.stdout.on("data", (data) => {
        const log = data.toString();
        console.log(`[SHOOTERGAME LOGS] ${serverName}:`, log);

        shooterGameKeywords.forEach(({ keyword, state }) => {
            if (log.includes(keyword)) {
                clearTimeout(timeout);
                logStream.kill();
                callback(state);
            }
        });
    });

    logStream.stderr.on("data", (data) => {
        console.error(`[SHOOTERGAME ERROR] ${serverName}:`, data.toString());
    });

    logStream.on("exit", (code) => {
        console.log(`[SHOOTERGAME MONITOR] ${serverName} exited with code ${code}`);
    });

    activeMonitors[serverName] = logStream;
}

/**
 * Monitors server state (Docker + ShooterGame) and updates UI accordingly.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {void}
 */
function monitorServerState(serverName) {
    let detectedState = "startup";

    // Monitor Docker logs first
    monitorDockerLogs(serverName, (state) => {
        if (state === "timeout") {
            detectedState = "failed";
            stopServerDueToFailure(serverName);
            return;
        }

        if (state === "wine ready") {
            console.log(`[MONITOR] Docker setup completed for ${serverName}, switching to ShooterGame logs...`);
            monitorShooterGameLog(serverName, (state) => {
                if (state === "timeout") {
                    detectedState = "failed";
                    stopServerDueToFailure(serverName);
                } else if (state === "Server running") {
                    detectedState = "running";
                    console.log(`[MONITOR] ${serverName} is now fully started.`);
                }
            });
        }
    });

    // Timeout auto-stop if stuck in startup
    setTimeout(() => {
        if (detectedState === "startup") {
            stopServerDueToFailure(serverName);
        }
    }, 300000); // 5 min timeout
}

/**
 * Stops the server and notifies UI if startup fails.
 * 
 * @param {string} serverName - Name of the server.
 * @returns {void}
 */
function stopServerDueToFailure(serverName) {
    console.log(`[FAILURE] Server ${serverName} failed to start within 5 minutes, stopping...`);
    dockerService.executeStopServer(serverName);
    uiService.notifyUser(`Server ${serverName} failed to start and was stopped automatically.`, "danger");
}

/*=======================================================================
 *                            EXPORTS
 *======================================================================*/

module.exports = { monitorServerState };
