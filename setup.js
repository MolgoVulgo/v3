const fs = require("fs");
const path = require("path");

const directories = [
  "compose-files",
  "config",
  "controllers",
  "data",
  "locales",
  "logs",
  "models",
  "public/css",
  "public/js",
  "routes",
  "services",
  "views"
];

directories.forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`📁 Created: ${dir}`);
  }
});

console.log("✅ Project structure is set up!");
