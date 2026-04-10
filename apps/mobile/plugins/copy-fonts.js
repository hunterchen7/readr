const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

module.exports = function copyFontsPlugin(config) {
  return withDangerousMod(config, [
    "android",
    (cfg) => {
      const srcDir = path.join(cfg.modRequest.projectRoot, "assets", "fonts");
      const destDir = path.join(
        cfg.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "assets",
        "fonts"
      );

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }

      if (fs.existsSync(srcDir)) {
        for (const file of fs.readdirSync(srcDir)) {
          if (file.endsWith(".ttf") || file.endsWith(".otf") || file.endsWith(".woff2")) {
            fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
          }
        }
      }

      return cfg;
    },
  ]);
};
