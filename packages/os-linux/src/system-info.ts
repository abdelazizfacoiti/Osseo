import type { OsseoConfig, CapabilityRegistrySnapshot, SystemInfo } from "@osseo/core";

export function getLinuxSystemInfo(
  config: OsseoConfig,
  registry: CapabilityRegistrySnapshot
): SystemInfo {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    osseoDir: config.osseoDir,
    strategies: registry.listStrategies(),
    tools: registry.listTools().map((tool) => tool.name)
  };
}
