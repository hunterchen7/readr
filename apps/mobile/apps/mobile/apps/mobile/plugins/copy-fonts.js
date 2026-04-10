const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");
module.exports = function copyAssetsPlugin(config) {
  return withDangerousMod(config, ["android", (cfg) => {
    const root = cfg.modRequest.projectRoot;
    const dest = path.join(cfg.modRequest.platformProjectRoot, "app", "src", "main", "assets");
    copyDir(path.join(root, "assets", "fonts"), path.join(dest, "fonts"), [".ttf", ".otf"]);
    copyDir(path.join(root, "assets", "js"), path.join(dest, "js"), [".js", ".mjs"]);
    return cfg;
  }]);
};
function copyDir(src, dest, exts) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dest, e.name), exts);
    else if (exts.some(x => e.name.endsWith(x))) fs.copyFileSync(path.join(src, e.name), path.join(dest, e.name));
  }
}
