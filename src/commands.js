import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show TeeMode Bot modules and commands'),
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder().setName('server').setDescription('Show server information'),
  new SlashCommandBuilder()
    .setName('user')
    .setDescription('Show user information')
    .addUserOption((option) => option.setName('target').setDescription('User to inspect').setRequired(false)),
  new SlashCommandBuilder()
    .setName('rank')
    .setDescription('Show level/rank')
    .addUserOption((option) => option.setName('target').setDescription('User to inspect').setRequired(false)),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member')
    .addUserOption((option) => option.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Ban reason').setRequired(true)),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member')
    .addUserOption((option) => option.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Kick reason').setRequired(true)),
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Timeout a member')
    .addUserOption((option) => option.setName('user').setDescription('User to mute').setRequired(true))
    .addStringOption((option) => option.setName('time').setDescription('Duration: 10m, 2h, 1d').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Mute reason').setRequired(true)),
  new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Configure welcome/goodbye messages')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('set').setDescription('Set welcome channel/message')
      .addChannelOption((option) => option.setName('channel').setDescription('Welcome channel').setRequired(true))
      .addStringOption((option) => option.setName('message').setDescription('Use {user} and {server}').setRequired(true)))
    .addSubcommand((sub) => sub.setName('goodbye').setDescription('Set goodbye channel/message')
      .addChannelOption((option) => option.setName('channel').setDescription('Goodbye channel').setRequired(true))
      .addStringOption((option) => option.setName('message').setDescription('Use {user} and {server}').setRequired(true))),
  new SlashCommandBuilder()
    .setName('logs')
    .setDescription('Configure moderation logs')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('set').setDescription('Set logs channel')
      .addChannelOption((option) => option.setName('channel').setDescription('Logs channel').setRequired(true))),
  new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Configure auto role')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) => sub.setName('set').setDescription('Set auto role')
      .addRoleOption((option) => option.setName('role').setDescription('Role to give new members').setRequired(true)))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Disable auto role')),
  new SlashCommandBuilder()
    .setName('levels')
    .setDescription('Configure levels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('enable').setDescription('Enable levels'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Disable levels'))
    .addSubcommand((sub) => sub.setName('channel').setDescription('Set level-up channel')
      .addChannelOption((option) => option.setName('channel').setDescription('Level-up channel').setRequired(true))),
  new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Create a role button message')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((sub) => sub.setName('button').setDescription('Create role button')
      .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true))
      .addRoleOption((option) => option.setName('role').setDescription('Role').setRequired(true))
      .addStringOption((option) => option.setName('label').setDescription('Button label').setRequired(true))
      .addStringOption((option) => option.setName('text').setDescription('Message text').setRequired(true))),
  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Create ticket panel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) => sub.setName('panel').setDescription('Create ticket panel')
      .addChannelOption((option) => option.setName('channel').setDescription('Channel').setRequired(true))
      .addStringOption((option) => option.setName('text').setDescription('Panel text').setRequired(true))),
  new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('Configure temporary voice channels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((sub) => sub.setName('set').setDescription('Set trigger voice channel')
      .addChannelOption((option) => option.setName('trigger').setDescription('Join this voice to create temp channel').setRequired(true))
      .addChannelOption((option) => option.setName('category').setDescription('Category for temp channels').setRequired(false))),
  new SlashCommandBuilder()
    .setName('embed')
    .setDescription('Send a custom embed')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addChannelOption((option) => option.setName('channel').setDescription('Target channel').setRequired(true))
    .addStringOption((option) => option.setName('title').setDescription('Embed title').setRequired(true))
    .addStringOption((option) => option.setName('description').setDescription('Embed description').setRequired(true))
    .addStringOption((option) => option.setName('color').setDescription('Hex color, example #7c3aed').setRequired(false)),
  new SlashCommandBuilder()
    .setName('automod')
    .setDescription('Configure simple automod')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) => sub.setName('enable').setDescription('Enable automod'))
    .addSubcommand((sub) => sub.setName('disable').setDescription('Disable automod'))
    .addSubcommand((sub) => sub.setName('addword').setDescription('Add banned word')
      .addStringOption((option) => option.setName('word').setDescription('Word').setRequired(true)))
    .addSubcommand((sub) => sub.setName('removeword').setDescription('Remove banned word')
      .addStringOption((option) => option.setName('word').setDescription('Word').setRequired(true))),
].map((command) => command.toJSON());
