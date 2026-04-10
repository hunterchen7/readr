const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

/** Copy bundled fonts and JS libs to android assets during prebuild */
module.exports = function copyAssetsPlugin(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const androidAssets = path.join(
        cfg.modRequest.platformProjectRoot,
        "app", "src", "main", "assets"
      );

      // Copy fonts
      copyDir(path.join(root, "assets", "fonts"), path.join(androidAssets, "fonts"), [".ttf", ".otf", ".woff2"]);
      // Copy JS (foliate-js)
      copyDir(path.join(root, "assets", "js"), path.join(androidAssets, "js"), [".js"]);

      return cfg;
    },
  ]);
};

function copyDir(src, dest, exts) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src)) {
    if (exts.some((e) => file.endsWith(e))) {
      fs.copyFileSync(path.join(src, file), path.join(dest, file));
    }
  }
}
