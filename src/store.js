import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('data');
const guildsPath = path.join(dataDir, 'guilds.json');
const levelsPath = path.join(dataDir, 'levels.json');

const defaultGuildConfig = {
  welcome: { channelId: null, message: 'Welcome {user} to {server}!' },
  goodbye: { channelId: null, message: '{user} left {server}.' },
  logs: { channelId: null },
  autorole: { roleId: null },
  levels: { enabled: false, channelId: null },
  automod: { enabled: false, bannedWords: [] },
  moderation: { moderatorRoleIds: [] },
  telegram: { enabled: false, chatId: null, discordChannelId: null },
  tempvoice: { categoryId: null, triggerChannelId: null },
  tickets: { categoryId: null, panelCategories: {} },
};

export const defaultConfig = structuredClone(defaultGuildConfig);

ensureDataFiles();

export function getGuildConfig(guildId) {
  const guilds = readJson(guildsPath, {});

  if (!guilds[guildId]) {
    guilds[guildId] = structuredClone(defaultGuildConfig);
    writeJson(guildsPath, guilds);
  }

  guilds[guildId] = mergeDefaults(guilds[guildId]);
  return guilds[guildId];
}

export function updateGuildConfig(guildId, updater) {
  const guilds = readJson(guildsPath, {});
  const current = mergeDefaults(guilds[guildId] ?? structuredClone(defaultGuildConfig));
  guilds[guildId] = updater(current) ?? current;
  writeJson(guildsPath, guilds);
  return guilds[guildId];
}

function mergeDefaults(config) {
  return {
    ...structuredClone(defaultGuildConfig),
    ...config,
    welcome: { ...defaultGuildConfig.welcome, ...config.welcome },
    goodbye: { ...defaultGuildConfig.goodbye, ...config.goodbye },
    logs: { ...defaultGuildConfig.logs, ...config.logs },
    autorole: { ...defaultGuildConfig.autorole, ...config.autorole },
    levels: { ...defaultGuildConfig.levels, ...config.levels },
    automod: { ...defaultGuildConfig.automod, ...config.automod },
    moderation: { ...defaultGuildConfig.moderation, ...config.moderation },
    telegram: { ...defaultGuildConfig.telegram, ...config.telegram },
    tempvoice: { ...defaultGuildConfig.tempvoice, ...config.tempvoice },
    tickets: { ...defaultGuildConfig.tickets, ...config.tickets },
  };
}

export function getUserLevel(guildId, userId) {
  const levels = readJson(levelsPath, {});
  return levels[guildId]?.[userId] ?? { xp: 0, level: 0, lastMessageAt: 0 };
}

export function updateUserLevel(guildId, userId, updater) {
  const levels = readJson(levelsPath, {});
  levels[guildId] ??= {};
  levels[guildId][userId] = updater(levels[guildId][userId] ?? { xp: 0, level: 0, lastMessageAt: 0 });
  writeJson(levelsPath, levels);
  return levels[guildId][userId];
}

export function levelFromXp(xp) {
  return Math.floor(Math.sqrt(xp / 100));
}

function ensureDataFiles() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(guildsPath)) writeJson(guildsPath, {});
  if (!fs.existsSync(levelsPath)) writeJson(levelsPath, {});
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
