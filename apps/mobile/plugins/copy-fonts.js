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
      // Copy JS (foliate-js, pdfjs, vendor deps)
      copyDir(path.join(root, "assets", "js"), path.join(androidAssets, "js"), [".js", ".mjs"]);

      return cfg;
    },
  ]);
};

function copyDir(src, dest, exts) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, exts);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
