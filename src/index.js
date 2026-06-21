import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionsBitField,
} from 'discord.js';
import { startDashboard } from './dashboard.js';
import { getGuildConfig, getUserLevel, levelFromXp, updateGuildConfig, updateUserLevel } from './store.js';

const { DISCORD_TOKEN } = process.env;
const privilegedIntentsEnabled = process.env.ENABLE_PRIVILEGED_INTENTS === 'true';
const tempChannels = new Map();
let telegramOffset = 0;
const processedTelegramMessages = new Set();

if (!DISCORD_TOKEN) throw new Error('Set DISCORD_TOKEN in .env');

const client = new Client({
  intents: privilegedIntentsEnabled ? [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ] : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  readyClient.user.setActivity('/help', { type: ActivityType.Watching });
  startDashboard(client);
  startTelegramBridge(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (!interaction.isChatInputCommand() || !interaction.guild) return;

    if (interaction.commandName === 'help') return interaction.reply({ embeds: [buildHelpEmbed()] });
    if (interaction.commandName === 'ping') return interaction.reply(`Pong: **${client.ws.ping}ms**`);
    if (interaction.commandName === 'server') return interaction.reply({ embeds: [buildServerEmbed(interaction.guild)] });
    if (interaction.commandName === 'user') return handleUser(interaction);
    if (interaction.commandName === 'rank') return handleRank(interaction);
    if (interaction.commandName === 'ban') return handleBan(interaction);
    if (interaction.commandName === 'kick') return handleKick(interaction);
    if (interaction.commandName === 'mute') return handleMute(interaction);
    if (interaction.commandName === 'welcome') return handleWelcome(interaction);
    if (interaction.commandName === 'logs') return handleLogs(interaction);
    if (interaction.commandName === 'autorole') return handleAutorole(interaction);
    if (interaction.commandName === 'levels') return handleLevels(interaction);
    if (interaction.commandName === 'reactionrole') return handleReactionRole(interaction);
    if (interaction.commandName === 'ticket') return handleTicketPanel(interaction);
    if (interaction.commandName === 'tempvoice') return handleTempVoice(interaction);
    if (interaction.commandName === 'embed') return handleEmbed(interaction);
    if (interaction.commandName === 'automod') return handleAutomod(interaction);
  } catch (error) {
    console.error(error);
    await safeReply(interaction, 'Command failed. Check the bot logs.');
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  const config = getGuildConfig(member.guild.id);

  if (config.autorole.roleId) {
    await member.roles.add(config.autorole.roleId).catch(console.error);
  }

  if (config.welcome.channelId) {
    await sendTemplate(member.guild, config.welcome.channelId, config.welcome.message, member);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const config = getGuildConfig(member.guild.id);
  if (config.goodbye.channelId) await sendTemplate(member.guild, config.goodbye.channelId, config.goodbye.message, member);
});

client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;

  await forwardDiscordToTelegram(message).catch(console.error);

  const config = getGuildConfig(message.guild.id);

  if (config.automod.enabled && config.automod.bannedWords.some((word) => message.content.toLowerCase().includes(word.toLowerCase()))) {
    await message.delete().catch(console.error);
    await message.channel.send(`${message.author}, message removed by automod.`).then((msg) => setTimeout(() => msg.delete().catch(() => {}), 5000));
    await logEvent(message.guild, 'Automod', `Deleted message from ${message.author} in ${message.channel}.`);
    return;
  }

  if (config.levels.enabled) {
    const now = Date.now();
    const previous = getUserLevel(message.guild.id, message.author.id);
    if (now - previous.lastMessageAt < 60_000) return;

    const updated = updateUserLevel(message.guild.id, message.author.id, (level) => {
      const xp = level.xp + Math.floor(Math.random() * 10) + 15;
      return { xp, level: levelFromXp(xp), lastMessageAt: now };
    });

    if (updated.level > previous.level) {
      const channel = config.levels.channelId ? message.guild.channels.cache.get(config.levels.channelId) : message.channel;
      await channel?.send(`${message.author} reached level **${updated.level}**!`).catch(console.error);
    }
  }
});

client.on(Events.MessageDelete, async (message) => {
  if (!message.guild || message.author?.bot) return;
  await logEvent(message.guild, 'Message Deleted', `Author: ${message.author}\nChannel: ${message.channel}\nContent: ${message.content || '[unknown]'}`);
});

client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  if (!oldMessage.guild || oldMessage.author?.bot || oldMessage.content === newMessage.content) return;
  await logEvent(oldMessage.guild, 'Message Edited', `Author: ${oldMessage.author}\nChannel: ${oldMessage.channel}\nBefore: ${oldMessage.content || '[unknown]'}\nAfter: ${newMessage.content || '[unknown]'}`);
});

client.on(Events.GuildBanAdd, async (ban) => logEvent(ban.guild, 'Member Banned', `${ban.user.tag} (${ban.user.id})`));
client.on(Events.GuildBanRemove, async (ban) => logEvent(ban.guild, 'Member Unbanned', `${ban.user.tag} (${ban.user.id})`));

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const config = getGuildConfig(newState.guild.id);
  if (!config.tempvoice.triggerChannelId) return;

  if (newState.channelId === config.tempvoice.triggerChannelId && newState.member) {
    const channel = await newState.guild.channels.create({
      name: `${newState.member.user.username}'s voice`,
      type: ChannelType.GuildVoice,
      parent: config.tempvoice.categoryId ?? newState.channel?.parentId ?? undefined,
      permissionOverwrites: [
        { id: newState.member.id, allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.MoveMembers] },
      ],
    });
    tempChannels.set(channel.id, newState.member.id);
    await newState.member.voice.setChannel(channel).catch(console.error);
  }

  if (oldState.channelId && tempChannels.has(oldState.channelId) && oldState.channel?.members.size === 0) {
    tempChannels.delete(oldState.channelId);
    await oldState.channel.delete().catch(console.error);
  }
});

async function handleUser(interaction) {
  const user = interaction.options.getUser('target') ?? interaction.user;
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  await interaction.reply({ embeds: [buildUserEmbed(user, member)] });
}

async function handleRank(interaction) {
  const user = interaction.options.getUser('target') ?? interaction.user;
  const level = getUserLevel(interaction.guild.id, user.id);
  await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x22d3ee).setTitle(`${user.username}'s rank`).addFields({ name: 'Level', value: String(level.level), inline: true }, { name: 'XP', value: String(level.xp), inline: true })] });
}

async function handleBan(interaction) {
  if (!canModerate(interaction.member, interaction.guild.id, PermissionsBitField.Flags.BanMembers)) {
    return interaction.reply({ content: 'No moderation permission.', flags: MessageFlags.Ephemeral });
  }

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (member && !member.bannable) return interaction.reply({ content: 'I cannot ban this member.', flags: MessageFlags.Ephemeral });
  if (member && !canActOnMember(interaction.member, member)) return interaction.reply({ content: 'You cannot moderate this member.', flags: MessageFlags.Ephemeral });

  await interaction.guild.members.ban(user.id, { reason: `${reason} | by ${interaction.user.tag}` });
  await interaction.reply({ content: `Banned ${user.tag}. Reason: ${reason}`, flags: MessageFlags.Ephemeral });
  await logEvent(interaction.guild, 'Member Banned', `${user.tag} (${user.id})\nModerator: ${interaction.user}\nReason: ${reason}`);
}

async function handleKick(interaction) {
  if (!canModerate(interaction.member, interaction.guild.id, PermissionsBitField.Flags.KickMembers)) {
    return interaction.reply({ content: 'No moderation permission.', flags: MessageFlags.Ephemeral });
  }

  const user = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason');
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return interaction.reply({ content: 'Member not found on this server.', flags: MessageFlags.Ephemeral });
  if (!member.kickable) return interaction.reply({ content: 'I cannot kick this member.', flags: MessageFlags.Ephemeral });
  if (!canActOnMember(interaction.member, member)) return interaction.reply({ content: 'You cannot moderate this member.', flags: MessageFlags.Ephemeral });

  await member.kick(`${reason} | by ${interaction.user.tag}`);
  await interaction.reply({ content: `Kicked ${user.tag}. Reason: ${reason}`, flags: MessageFlags.Ephemeral });
  await logEvent(interaction.guild, 'Member Kicked', `${user.tag} (${user.id})\nModerator: ${interaction.user}\nReason: ${reason}`);
}

async function handleMute(interaction) {
  if (!canModerate(interaction.member, interaction.guild.id, PermissionsBitField.Flags.ModerateMembers)) {
    return interaction.reply({ content: 'No moderation permission.', flags: MessageFlags.Ephemeral });
  }

  const user = interaction.options.getUser('user');
  const durationMs = parseDuration(interaction.options.getString('time'));
  const reason = interaction.options.getString('reason');
  if (!durationMs) return interaction.reply({ content: 'Invalid time. Use 10m, 2h, 1d. Discord timeout limit is 28d.', flags: MessageFlags.Ephemeral });

  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return interaction.reply({ content: 'Member not found on this server.', flags: MessageFlags.Ephemeral });
  if (!member.moderatable) return interaction.reply({ content: 'I cannot mute this member.', flags: MessageFlags.Ephemeral });
  if (!canActOnMember(interaction.member, member)) return interaction.reply({ content: 'You cannot moderate this member.', flags: MessageFlags.Ephemeral });

  await member.timeout(durationMs, `${reason} | by ${interaction.user.tag}`);
  await interaction.reply({ content: `Muted ${user.tag} for ${formatDuration(durationMs)}. Reason: ${reason}`, flags: MessageFlags.Ephemeral });
  await logEvent(interaction.guild, 'Member Muted', `${user.tag} (${user.id})\nModerator: ${interaction.user}\nDuration: ${formatDuration(durationMs)}\nReason: ${reason}`);
}

async function handleWelcome(interaction) {
  const sub = interaction.options.getSubcommand();
  const channel = interaction.options.getChannel('channel');
  const message = interaction.options.getString('message');
  updateGuildConfig(interaction.guild.id, (config) => {
    config[sub === 'set' ? 'welcome' : 'goodbye'] = { channelId: channel.id, message };
    return config;
  });
  await interaction.reply({ content: `${sub === 'set' ? 'Welcome' : 'Goodbye'} message configured.`, flags: MessageFlags.Ephemeral });
}

async function handleLogs(interaction) {
  const channel = interaction.options.getChannel('channel');
  updateGuildConfig(interaction.guild.id, (config) => { config.logs.channelId = channel.id; return config; });
  await interaction.reply({ content: 'Logs channel configured.', flags: MessageFlags.Ephemeral });
}

async function handleAutorole(interaction) {
  const sub = interaction.options.getSubcommand();
  const role = interaction.options.getRole('role');
  updateGuildConfig(interaction.guild.id, (config) => { config.autorole.roleId = sub === 'set' ? role.id : null; return config; });
  await interaction.reply({ content: sub === 'set' ? `Autorole set to ${role}.` : 'Autorole disabled.', flags: MessageFlags.Ephemeral });
}

async function handleLevels(interaction) {
  const sub = interaction.options.getSubcommand();
  updateGuildConfig(interaction.guild.id, (config) => {
    if (sub === 'enable') config.levels.enabled = true;
    if (sub === 'disable') config.levels.enabled = false;
    if (sub === 'channel') config.levels.channelId = interaction.options.getChannel('channel').id;
    return config;
  });
  await interaction.reply({ content: `Levels ${sub} configured.`, flags: MessageFlags.Ephemeral });
}

async function handleReactionRole(interaction) {
  const channel = interaction.options.getChannel('channel');
  const role = interaction.options.getRole('role');
  const label = interaction.options.getString('label');
  const text = interaction.options.getString('text');
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`role:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary));
  await channel.send({ content: text, components: [row] });
  await interaction.reply({ content: 'Reaction role button sent.', flags: MessageFlags.Ephemeral });
}

async function handleTicketPanel(interaction) {
  const channel = interaction.options.getChannel('channel');
  const text = interaction.options.getString('text');
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:create').setLabel('Create ticket').setStyle(ButtonStyle.Success));
  await channel.send({ content: text, components: [row] });
  await interaction.reply({ content: 'Ticket panel sent.', flags: MessageFlags.Ephemeral });
}

async function handleTempVoice(interaction) {
  const trigger = interaction.options.getChannel('trigger');
  const category = interaction.options.getChannel('category');
  updateGuildConfig(interaction.guild.id, (config) => { config.tempvoice.triggerChannelId = trigger.id; config.tempvoice.categoryId = category?.id ?? null; return config; });
  await interaction.reply({ content: 'Temporary voice configured.', flags: MessageFlags.Ephemeral });
}

async function handleEmbed(interaction) {
  const channel = interaction.options.getChannel('channel');
  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description');
  const color = parseColor(interaction.options.getString('color'));
  await channel.send({ embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description)] });
  await interaction.reply({ content: 'Embed sent.', flags: MessageFlags.Ephemeral });
}

async function handleAutomod(interaction) {
  const sub = interaction.options.getSubcommand();
  const word = interaction.options.getString('word');
  updateGuildConfig(interaction.guild.id, (config) => {
    if (sub === 'enable') config.automod.enabled = true;
    if (sub === 'disable') config.automod.enabled = false;
    if (sub === 'addword' && word && !config.automod.bannedWords.includes(word)) config.automod.bannedWords.push(word);
    if (sub === 'removeword' && word) config.automod.bannedWords = config.automod.bannedWords.filter((item) => item !== word);
    return config;
  });
  await interaction.reply({ content: `Automod ${sub} configured.`, flags: MessageFlags.Ephemeral });
}

async function handleButton(interaction) {
  if (!interaction.guild || !interaction.member) return;

  if (interaction.customId.startsWith('role:')) {
    const roleId = interaction.customId.split(':')[1];
    const hasRole = interaction.member.roles.cache.has(roleId);
    if (hasRole) await interaction.member.roles.remove(roleId);
    else await interaction.member.roles.add(roleId);
    await interaction.reply({ content: hasRole ? 'Role removed.' : 'Role added.', flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'ticket:create') {
    const config = getGuildConfig(interaction.guild.id);
    const categoryId = config.tickets?.panelCategories?.[interaction.channelId]
      ?? config.tickets?.categoryId
      ?? interaction.channel?.parentId
      ?? undefined;
    const channel = await interaction.guild.channels.create({
      name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      type: ChannelType.GuildText,
      parent: categoryId,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ],
    });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger));
    await channel.send({ content: `${interaction.user}, ticket created.`, components: [row] });
    await interaction.reply({ content: `Ticket created: ${channel}`, flags: MessageFlags.Ephemeral });
  }

  if (interaction.customId === 'ticket:close') {
    await interaction.reply({ content: 'Closing ticket in 3 seconds.', flags: MessageFlags.Ephemeral });
    setTimeout(() => interaction.channel?.delete().catch(console.error), 3000);
  }
}

function buildHelpEmbed() {
  return new EmbedBuilder().setColor(0x7c3aed).setTitle('TeeMode Bot').setDescription('Juniper-style utility bot.').addFields(
    { name: 'Core', value: '`/help`, `/ping`, `/server`, `/user`' },
    { name: 'Modules', value: '`/welcome`, `/logs`, `/autorole`, `/levels`, `/reactionrole`, `/ticket`, `/tempvoice`, `/embed`, `/automod`, `/rank`, `/ban`, `/kick`, `/mute`' },
  );
}

function buildServerEmbed(guild) {
  return new EmbedBuilder().setColor(0x7c3aed).setTitle(guild.name).setThumbnail(guild.iconURL({ size: 256 })).addFields(
    { name: 'Members', value: String(guild.memberCount), inline: true },
    { name: 'Channels', value: String(guild.channels.cache.size), inline: true },
    { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
    { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
  );
}

function buildUserEmbed(user, member) {
  const embed = new EmbedBuilder().setColor(0x22d3ee).setTitle(user.tag).setThumbnail(user.displayAvatarURL({ size: 256 })).addFields(
    { name: 'ID', value: user.id, inline: true },
    { name: 'Created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
  );
  if (member) embed.addFields({ name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true }, { name: 'Top Role', value: member.roles.highest.toString(), inline: true });
  return embed;
}

async function sendTemplate(guild, channelId, template, member) {
  const channel = guild.channels.cache.get(channelId);
  const content = template.replaceAll('{user}', `${member.user}`).replaceAll('{server}', guild.name);
  await channel?.send(content).catch(console.error);
}

async function logEvent(guild, title, description) {
  const channelId = getGuildConfig(guild.id).logs.channelId;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  await channel?.send({ embeds: [new EmbedBuilder().setColor(0xf97316).setTitle(title).setDescription(truncate(description, 3900)).setTimestamp()] }).catch(console.error);
}

function startTelegramBridge(discordClient) {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.log('Telegram bridge disabled: TELEGRAM_BOT_TOKEN is missing');
    return;
  }

  pollTelegram(discordClient).catch(console.error);
}

async function pollTelegram(discordClient) {
  while (true) {
    try {
      const config = getTelegramBridgeConfig(discordClient);
      if (!config?.enabled || !config.chatId || !config.discordChannelId) {
        await sleep(10_000);
        continue;
      }

      const updates = await telegramApi('getUpdates', {
        offset: telegramOffset || undefined,
        timeout: 30,
        allowed_updates: ['message', 'edited_message'],
      });

      for (const update of updates.result ?? []) {
        telegramOffset = update.update_id + 1;
        const message = update.message ?? update.edited_message;
        if (!message || String(message.chat.id) !== String(config.chatId) || message.from?.is_bot) continue;
        const messageKey = `${message.chat.id}:${message.message_id}`;
        if (processedTelegramMessages.has(messageKey)) continue;
        processedTelegramMessages.add(messageKey);
        if (processedTelegramMessages.size > 1000) processedTelegramMessages.clear();
        await forwardTelegramToDiscord(discordClient, message, config.discordChannelId, Boolean(update.edited_message));
      }
    } catch (error) {
      console.error('Telegram bridge error:', error);
      await sleep(10_000);
    }
  }
}

async function forwardTelegramToDiscord(discordClient, message, channelId, edited) {
  const channel = discordClient.channels.cache.get(channelId) ?? await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  const author = formatTelegramAuthor(message.from);
  const text = message.text ?? message.caption ?? '';
  const prefix = edited ? '[TG edited]' : '[TG]';
  const files = await getTelegramFiles(message);
  const content = truncate(`${prefix} **${escapeDiscord(author)}**${text ? `\n${escapeDiscord(text)}` : ''}`, 1900);
  await channel.send({ content: content || `${prefix} **${escapeDiscord(author)}**`, files }).catch(console.error);
}

async function forwardDiscordToTelegram(message) {
  const config = getGuildConfig(message.guild.id).telegram;
  if (!process.env.TELEGRAM_BOT_TOKEN || !config?.enabled || String(message.channelId) !== String(config.discordChannelId) || !config.chatId) return;

  const mediaUrls = await extractDiscordMediaUrls(message);
  const textContent = removeUrls(message.content || '', mediaUrls.consumedUrls).trim();
  const caption = `[DS] ${message.author.tag}${textContent ? `\n${textContent}` : ''}`.slice(0, 1024);
  const hasMedia = mediaUrls.mediaUrls.length > 0 || message.attachments.size > 0;
  if (!hasMedia && caption.trim()) await telegramApi('sendMessage', { chat_id: config.chatId, text: caption, disable_web_page_preview: false });

  let captionSent = false;
  for (const url of mediaUrls.mediaUrls) {
    await sendTelegramAttachment(config.chatId, url, '', '', captionSent ? '' : caption).then(() => { captionSent = true; }).catch(console.error);
  }

  for (const attachment of message.attachments.values()) {
    await sendTelegramAttachment(config.chatId, attachment.url, attachment.contentType, attachment.name, captionSent ? '' : caption).then(() => { captionSent = true; }).catch(console.error);
  }
}

async function getTelegramFiles(message) {
  const fileIds = new Set();
  if (message.photo?.length) fileIds.add(message.photo.at(-1).file_id);
  for (const key of ['document', 'video', 'animation', 'audio', 'voice', 'video_note', 'sticker']) {
    if (message[key]?.file_id) fileIds.add(message[key].file_id);
  }

  const files = [];
  for (const fileId of Array.from(fileIds).slice(0, 10)) {
    const file = await telegramApi('getFile', { file_id: fileId });
    if (file.result?.file_path) files.push(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.result.file_path}`);
  }
  return files;
}

async function sendTelegramAttachment(chatId, url, contentType = '', name = '', caption = '') {
  if (isAnimation(url, contentType, name)) return sendTelegramDownloadedFile(chatId, url, 'sendAnimation', 'animation', caption);
  if (contentType?.startsWith('image/')) return telegramApi('sendPhoto', { chat_id: chatId, photo: url, caption: caption || undefined });
  if (contentType?.startsWith('video/')) return telegramApi('sendVideo', { chat_id: chatId, video: url, caption: caption || undefined });
  if (contentType?.startsWith('audio/')) return telegramApi('sendAudio', { chat_id: chatId, audio: url, caption: caption || undefined });
  return telegramApi('sendDocument', { chat_id: chatId, document: url, caption: caption || undefined });
}

async function sendTelegramDownloadedFile(chatId, url, method, fieldName, caption = '') {
  const extension = getMediaExtension(url);
  const mimeType = extension === 'mp4' ? 'video/mp4' : 'image/gif';
  const tempPath = path.join(os.tmpdir(), `teemode-${randomUUID()}.${extension}`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > 45 * 1024 * 1024) throw new Error('Telegram file is too large');

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > 45 * 1024 * 1024) throw new Error('Telegram file is too large');

    await fs.writeFile(tempPath, buffer);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption);
    form.set(fieldName, new Blob([await fs.readFile(tempPath)], { type: mimeType }), `animation.${extension}`);

    const telegramResponse = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      body: form,
    });
    const data = await telegramResponse.json().catch(() => null);
    if (!telegramResponse.ok || !data?.ok) throw new Error(`Telegram ${method} failed: ${telegramResponse.status} ${JSON.stringify(data)}`);
    return data;
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

async function extractDiscordMediaUrls(message) {
  const consumedUrls = extractUrls(message.content || '');
  const directUrls = extractDirectMediaUrls(message.content || '');
  const embedUrls = message.embeds.flatMap((embed) => [
    embed.thumbnail?.url,
    embed.video?.url,
    embed.image?.url,
    embed.url,
  ]).filter(Boolean);
  const tenorUrls = [...consumedUrls, ...embedUrls].filter(isTenorUrl);
  const resolvedTenorUrls = [];

  for (const url of tenorUrls) {
    const resolved = await resolveTenorMediaUrl(url).catch((error) => {
      console.error('Tenor resolve failed:', error);
      return null;
    });
    if (resolved) resolvedTenorUrls.push(resolved);
  }

  const mediaUrls = uniqueMediaUrls([...embedUrls.filter(isDirectMediaUrl), ...directUrls, ...resolvedTenorUrls]);
  return { mediaUrls, consumedUrls };
}

function extractUrls(text) {
  return Array.from(String(text).matchAll(/https?:\/\/\S+/gi))
    .map((match) => match[0].replace(/[>)\].,]+$/, ''))
}

function extractDirectMediaUrls(text) {
  return extractUrls(text)
    .filter((url) => /\.(gif|mp4|webm)(\?.*)?$/i.test(url));
}

function removeUrls(text, urls) {
  return urls.reduce((value, url) => value.replace(url, ''), String(text));
}

function isDirectMediaUrl(url) {
  return /\.(gif|mp4|webm)(\?.*)?$/i.test(String(url));
}

function isTenorUrl(url) {
  return /^https?:\/\/(www\.)?tenor\.com\//i.test(String(url));
}

async function resolveTenorMediaUrl(url) {
  const oembedResponse = await fetch(`https://tenor.com/oembed?url=${encodeURIComponent(url)}`);
  if (oembedResponse.ok) {
    const data = await oembedResponse.json().catch(() => null);
    const fromHtml = extractDirectMediaUrls(data?.html || '');
    const gif = fromHtml.find((item) => /\.gif(\?.*)?$/i.test(item));
    if (gif) return gif;
    if (fromHtml[0]) return fromHtml[0];
  }

  const pageResponse = await fetch(url);
  if (!pageResponse.ok) return null;
  const html = await pageResponse.text();
  const candidates = unique([
    ...Array.from(html.matchAll(/property=["']og:(?:image|video|video:url)["']\s+content=["']([^"']+)["']/gi)).map((match) => match[1]),
    ...Array.from(html.matchAll(/content=["']([^"']*media\.tenor\.com[^"']+)["']/gi)).map((match) => match[1]),
    ...extractDirectMediaUrls(html),
  ]).map((item) => item.replaceAll('&amp;', '&'));
  return candidates.find((item) => /\.gif(\?.*)?$/i.test(item)) ?? candidates.find(isDirectMediaUrl) ?? null;
}

function isAnimation(url, contentType = '', name = '') {
  return contentType === 'image/gif'
    || /\.(gif|mp4|webm)(\?.*)?$/i.test(url)
    || /\.(gif|mp4|webm)$/i.test(name);
}

function getMediaExtension(url) {
  const match = String(url).match(/\.(gif|mp4|webm)(?:\?|$)/i);
  return match?.[1]?.toLowerCase() === 'webm' ? 'mp4' : match?.[1]?.toLowerCase() || 'gif';
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function uniqueMediaUrls(items) {
  const seen = new Map();
  const result = [];
  for (const item of items.filter(Boolean)) {
    const key = String(item).split('?')[0];
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (!String(result[existingIndex]).includes('?') && String(item).includes('?')) result[existingIndex] = item;
      continue;
    }
    seen.set(key, result.length);
    result.push(item);
  }
  return result;
}

async function telegramApi(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(`Telegram ${method} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function getTelegramBridgeConfig(discordClient) {
  const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID) ?? discordClient.guilds.cache.first();
  return guild ? getGuildConfig(guild.id).telegram : null;
}

function formatTelegramAuthor(user) {
  if (!user) return 'Unknown';
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || String(user.id);
}

function escapeDiscord(value) {
  return String(value).replaceAll('@', '@\u200b');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReply(interaction, content) {
  if (interaction.replied || interaction.deferred) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function parseColor(value) {
  if (!value) return 0x7c3aed;
  const normalized = value.replace('#', '');
  return /^[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized, 16) : 0x7c3aed;
}

function canModerate(member, guildId, permission) {
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(permission)) return true;

  const moderatorRoleIds = getGuildConfig(guildId).moderation?.moderatorRoleIds ?? [];
  return moderatorRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

function canActOnMember(moderator, target) {
  if (!moderator || !target || moderator.id === target.id) return false;
  if (moderator.guild.ownerId === moderator.id) return true;
  if (target.guild.ownerId === target.id) return false;
  return moderator.roles.highest.position > target.roles.highest.position;
}

function parseDuration(value) {
  const match = String(value || '').trim().toLowerCase().match(/^(\d{1,4})\s*(m|м|min|mins|minute|minutes|мин|минута|минут|h|ч|hr|hrs|hour|hours|час|часа|часов|d|д|day|days|день|дня|дней)$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = ['m', 'м', 'min', 'mins', 'minute', 'minutes', 'мин', 'минута', 'минут'].includes(unit)
    ? 60_000
    : ['h', 'ч', 'hr', 'hrs', 'hour', 'hours', 'час', 'часа', 'часов'].includes(unit)
      ? 3_600_000
      : 86_400_000;
  const duration = amount * multiplier;
  return duration > 0 && duration <= 28 * 86_400_000 ? duration : null;
}

function formatDuration(durationMs) {
  if (durationMs % 86_400_000 === 0) return `${durationMs / 86_400_000}d`;
  if (durationMs % 3_600_000 === 0) return `${durationMs / 3_600_000}h`;
  return `${Math.round(durationMs / 60_000)}m`;
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

client.login(DISCORD_TOKEN);
