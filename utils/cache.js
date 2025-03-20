const cache = {
    serversStatus: {},  // déjà existant
    hostStats: { CPU_USAGE: "N/A", MEMORY_USAGE: "N/A" },
    containersStats: {}  // Nouveau → par container: { [containerId]: { name, CPU_USAGE, MEMORY_USAGE } }
};

module.exports = cache;
