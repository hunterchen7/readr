// Metro config for pnpm monorepo — see
// https://docs.expo.dev/guides/monorepos/ and
// https://pnpm.io/symlinked-node-modules-structure
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// 1. Watch all workspace files so Metro picks up changes in packages/*
config.watchFolders = [workspaceRoot];

// 2. Tell Metro to look in both the local and workspace root node_modules.
//    pnpm keeps direct deps under apps/mobile/node_modules and peer/transitive
//    deps hoisted to the workspace-root node_modules.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
