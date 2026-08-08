const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const dependencyName = "@supabase/supabase-js";
const expectedVersion = require(path.join(root, "package.json")).dependencies[dependencyName];
const installedPackagePath = path.join(root, "node_modules", dependencyName, "package.json");

if (!fs.existsSync(installedPackagePath)) {
  throw new Error("Supabase JavaScript SDK is missing. Run npm ci before building the app.");
}

const installedPackage = require(installedPackagePath);
if (expectedVersion !== installedPackage.version) {
  throw new Error(`Expected ${dependencyName}@${expectedVersion}, found ${installedPackage.version}. Run npm ci.`);
}

const files = [
  {
    source: path.join(root, "node_modules", dependencyName, "dist", "umd", "supabase.js"),
    destination: path.join(root, "RORC App", "vendor", "supabase.min.js")
  },
  {
    source: path.join(root, "node_modules", dependencyName, "LICENSE"),
    destination: path.join(root, "RORC App", "vendor", "SUPABASE-JS-LICENSE")
  }
];

function filesMatch(source, destination) {
  return fs.existsSync(destination) && fs.readFileSync(source).equals(fs.readFileSync(destination));
}

if (process.argv.includes("--check")) {
  const stale = files.filter(({ source, destination }) => !filesMatch(source, destination));
  if (stale.length) {
    const names = stale.map(({ destination }) => path.relative(root, destination)).join(", ");
    throw new Error(`Supabase browser assets are out of date: ${names}. Run npm run build:supabase-client.`);
  }
  console.log(`Supabase browser assets match ${dependencyName}@${expectedVersion}.`);
} else {
  for (const { source, destination } of files) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  console.log(`Copied ${dependencyName}@${expectedVersion} browser assets.`);
}
