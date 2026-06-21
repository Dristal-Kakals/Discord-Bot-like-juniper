import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { parse, serialize } from 'cookie';
import fs from 'node:fs';
import https from 'node:https';
import helmet from 'helmet';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionsBitField } from 'discord.js';
import { defaultConfig, getGuildConfig, updateGuildConfig } from './store.js';

const sessions = new Map();

export function startDashboard(client) {
  const port = Number(process.env.WEB_PORT || 3555);
  const keyPath = process.env.WEB_SSL_KEY || '/opt/dsbot/certs/key.pem';
  const certPath = process.env.WEB_SSL_CERT || '/opt/dsbot/certs/cert.pem';
  const publicUrl = process.env.WEB_PUBLIC_URL || `https://144.31.235.172:${port}`;

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '20kb' }));
  app.use('/api/', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

  app.get('/', (_request, response) => response.type('html').send(renderPage()));

  app.get('/auth/login', (_request, response) => {
    if (!process.env.DISCORD_CLIENT_ID) {
      response.status(500).send('Discord client id is missing');
      return;
    }

    const state = crypto.randomUUID();
    const url = new URL('https://discord.com/oauth2/authorize');
    url.searchParams.set('client_id', process.env.DISCORD_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${publicUrl}/auth/callback`);
    url.searchParams.set('response_type', process.env.DISCORD_CLIENT_SECRET ? 'code' : 'token');
    url.searchParams.set('scope', 'identify');
    url.searchParams.set('state', state);
    response.setHeader('Set-Cookie', serialize('tm_oauth_state', state, cookieOptions({ maxAge: 300 })));
    response.redirect(url.toString());
  });

  app.post('/auth/token', async (request, response) => {
    try {
      const cookies = parse(request.headers.cookie || '');
      if (!request.body?.accessToken || request.body?.state !== cookies.tm_oauth_state) {
        response.status(400).json({ error: 'Invalid OAuth state' });
        return;
      }

      const user = await fetchDiscordUser(request.body.accessToken);
      if (!user?.id || !await isDashboardAdmin(client, user.id)) {
        response.status(403).json({ error: 'You need Administrator permission or admin role on this server.' });
        return;
      }

      setSession(response, user);
      response.json({ ok: true });
    } catch (error) {
      console.error(error);
      response.status(500).json({ error: 'OAuth failed' });
    }
  });

  app.get('/auth/callback', async (request, response) => {
    try {
      if (!request.query.code) {
        response.type('html').send(renderPage());
        return;
      }

      const cookies = parse(request.headers.cookie || '');
      if (!request.query.code || request.query.state !== cookies.tm_oauth_state) {
        response.status(400).send('Invalid OAuth state');
        return;
      }

      const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID,
          client_secret: process.env.DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code: String(request.query.code),
          redirect_uri: `${publicUrl}/auth/callback`,
        }),
      });

      if (!tokenResponse.ok) {
        response.status(401).send('Discord OAuth failed');
        return;
      }

      const token = await tokenResponse.json();
      const user = await fetchDiscordUser(token.access_token);

      if (!await isDashboardAdmin(client, user.id)) {
        response.status(403).send('You need Administrator permission or admin role on this server.');
        return;
      }

      setSession(response, user);
      response.redirect('/');
    } catch (error) {
      console.error(error);
      response.status(500).send('OAuth failed');
    }
  });

  app.post('/auth/logout', (request, response) => {
    const session = getSession(request);
    if (session?.id) sessions.delete(session.id);
    response.setHeader('Set-Cookie', serialize('tm_session', '', cookieOptions({ maxAge: 0 })));
    response.json({ ok: true });
  });

  app.get('/api/me', requireAuth(client), (request, response) => {
    response.json({ user: request.dashboardSession });
  });

  app.get('/api/bootstrap', requireAuth(client), async (_request, response) => {
    const guild = getGuild(client);
    if (!guild) return response.status(404).json({ error: 'Guild not found' });

    await guild.channels.fetch().catch(() => null);
    await guild.roles.fetch().catch(() => null);

    response.json({
      guild: { id: guild.id, name: guild.name },
      config: getGuildConfig(guild.id),
      defaults: defaultConfig,
      channels: guild.channels.cache
        .filter((channel) => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
        .map((channel) => ({ id: channel.id, name: channel.name, type: 'text' }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      voiceChannels: guild.channels.cache
        .filter((channel) => channel.isVoiceBased())
        .map((channel) => ({ id: channel.id, name: channel.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      categories: guild.channels.cache
        .filter((channel) => channel.type === ChannelType.GuildCategory)
        .map((channel) => ({ id: channel.id, name: channel.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      roles: guild.roles.cache
        .filter((role) => role.name !== '@everyone' && !role.managed)
        .map((role) => ({ id: role.id, name: role.name, position: role.position }))
        .sort((a, b) => b.position - a.position),
    });
  });

  app.post('/api/config', requireAuth(client), (request, response) => {
    const guild = getGuild(client);
    if (!guild) return response.status(404).json({ error: 'Guild not found' });

    const next = sanitizeConfig(request.body ?? {});
    const config = updateGuildConfig(guild.id, (current) => ({
      ...next,
      tickets: {
        ...current.tickets,
        ...next.tickets,
        panelCategories: current.tickets?.panelCategories ?? {},
      },
    }));
    response.json({ ok: true, config });
  });

  app.post('/api/ticket-panel', requireAuth(client), async (request, response) => {
    const guild = getGuild(client);
    if (!guild) return response.status(404).json({ error: 'Guild not found' });

    const channel = guild.channels.cache.get(cleanId(request.body?.channelId));
    if (!channel?.isTextBased()) return response.status(400).json({ error: 'Invalid channel' });

    const categoryId = cleanId(request.body?.categoryId) ?? channel.parentId ?? null;
    updateGuildConfig(guild.id, (config) => {
      config.tickets ??= { categoryId: null, panelCategories: {} };
      config.tickets.panelCategories ??= {};
      config.tickets.categoryId = categoryId;
      config.tickets.panelCategories[channel.id] = categoryId;
      return config;
    });

    const text = cleanText(request.body?.text, 'Create a ticket when you need help.', 1800);
    const label = cleanText(request.body?.buttonLabel, 'Create ticket', 80);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket:create').setLabel(label).setStyle(ButtonStyle.Success));
    const message = await channel.send({ content: text, components: [row] });
    response.json({ ok: true, messageId: message.id });
  });

  app.post('/api/ticket-category', requireAuth(client), (request, response) => {
    const guild = getGuild(client);
    if (!guild) return response.status(404).json({ error: 'Guild not found' });

    const panelChannelId = cleanId(request.body?.channelId);
    const categoryId = cleanId(request.body?.categoryId);
    const panelChannel = panelChannelId ? guild.channels.cache.get(panelChannelId) : null;
    if (panelChannelId && !panelChannel?.isTextBased()) return response.status(400).json({ error: 'Invalid panel channel' });
    if (categoryId && guild.channels.cache.get(categoryId)?.type !== ChannelType.GuildCategory) {
      return response.status(400).json({ error: 'Invalid category' });
    }

    const config = updateGuildConfig(guild.id, (current) => {
      current.tickets ??= { categoryId: null, panelCategories: {} };
      current.tickets.panelCategories ??= {};
      current.tickets.categoryId = categoryId;
      if (panelChannelId) current.tickets.panelCategories[panelChannelId] = categoryId;
      return current;
    });
    return response.json({ ok: true, config });
  });

  app.post('/api/bot-message', requireAuth(client), async (request, response) => {
    const guild = getGuild(client);
    if (!guild) return response.status(404).json({ error: 'Guild not found' });

    const channel = guild.channels.cache.get(cleanId(request.body?.channelId));
    if (!channel?.isTextBased()) return response.status(400).json({ error: 'Invalid channel' });

    const payload = buildBotMessagePayload(request.body ?? {});
    const messageId = cleanId(request.body?.messageId);
    if (messageId) {
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message || message.author.id !== client.user.id) return response.status(404).json({ error: 'Bot message not found' });
      const updated = await message.edit(payload);
      response.json({ ok: true, messageId: updated.id });
      return;
    }

    const message = await channel.send(payload);
    response.json({ ok: true, messageId: message.id });
  });

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error(`Dashboard SSL files missing: ${keyPath}, ${certPath}`);
    return;
  }

  https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
    .listen(port, '0.0.0.0', () => console.log(`Dashboard listening on https://0.0.0.0:${port}`));
}

async function fetchDiscordUser(accessToken) {
  const userResponse = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userResponse.ok) return null;
  return userResponse.json();
}

function setSession(response, user) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { userId: user.id, username: user.global_name || user.username, createdAt: Date.now() });
  response.setHeader('Set-Cookie', [
    serialize('tm_session', sessionId, cookieOptions({ maxAge: 60 * 60 * 24 * 7 })),
    serialize('tm_oauth_state', '', cookieOptions({ maxAge: 0 })),
  ]);
}

function buildBotMessagePayload(input) {
  const content = cleanText(input.content, '', 1800);
  const title = cleanText(input.title, '', 256);
  const description = cleanText(input.description, '', 3900);
  const color = parseColor(input.color, 0x22d3ee);
  const payload = { content: content || null, embeds: [] };

  if (title || description) {
    const embed = new EmbedBuilder().setColor(color);
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    payload.embeds = [embed];
  }

  return payload;
}

function getGuild(client) {
  return client.guilds.cache.get(process.env.DISCORD_GUILD_ID) ?? client.guilds.cache.first();
}

function requireAuth(client) {
  return async (request, response, next) => {
    const session = getSession(request);
    if (!session || !await isDashboardAdmin(client, session.userId)) {
      return response.status(401).json({ error: 'Unauthorized' });
    }

    request.dashboardSession = session;
    return next();
  };
}

function getSession(request) {
  const cookies = parse(request.headers.cookie || '');
  const id = cookies.tm_session;
  const session = id ? sessions.get(id) : null;
  return session ? { id, ...session } : null;
}

async function isDashboardAdmin(client, userId) {
  const guild = getGuild(client);
  if (!guild || !userId) return false;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;

  return member.permissions.has(PermissionsBitField.Flags.Administrator)
    || member.roles.cache.some((role) => role.permissions.has(PermissionsBitField.Flags.Administrator))
    || member.roles.cache.some((role) => /^(admin|administrator|админ|администратор)$/i.test(role.name));
}

function cookieOptions({ maxAge }) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}

function sanitizeConfig(input) {
  return {
    welcome: {
      channelId: cleanId(input.welcome?.channelId),
      message: cleanText(input.welcome?.message, defaultConfig.welcome.message, 500),
    },
    goodbye: {
      channelId: cleanId(input.goodbye?.channelId),
      message: cleanText(input.goodbye?.message, defaultConfig.goodbye.message, 500),
    },
    logs: { channelId: cleanId(input.logs?.channelId) },
    autorole: { roleId: cleanId(input.autorole?.roleId) },
    levels: {
      enabled: Boolean(input.levels?.enabled),
      channelId: cleanId(input.levels?.channelId),
    },
    automod: {
      enabled: Boolean(input.automod?.enabled),
      bannedWords: Array.isArray(input.automod?.bannedWords)
        ? input.automod.bannedWords.map((word) => cleanText(word, '', 60)).filter(Boolean).slice(0, 100)
        : [],
    },
    moderation: {
      moderatorRoleIds: Array.isArray(input.moderation?.moderatorRoleIds)
        ? input.moderation.moderatorRoleIds.map(cleanId).filter(Boolean).slice(0, 50)
        : [],
    },
    telegram: {
      enabled: Boolean(input.telegram?.enabled),
      chatId: cleanTelegramChatId(input.telegram?.chatId),
      discordChannelId: cleanId(input.telegram?.discordChannelId),
    },
    tempvoice: {
      categoryId: cleanId(input.tempvoice?.categoryId),
      triggerChannelId: cleanId(input.tempvoice?.triggerChannelId),
    },
    tickets: {
      categoryId: cleanId(input.tickets?.categoryId),
      panelCategories: typeof input.tickets?.panelCategories === 'object' && input.tickets.panelCategories
        ? Object.fromEntries(Object.entries(input.tickets.panelCategories)
          .map(([channelId, categoryId]) => [cleanId(channelId), cleanId(categoryId)])
          .filter(([channelId, categoryId]) => channelId && categoryId))
        : {},
    },
  };
}

function cleanId(value) {
  const text = String(value || '').trim();
  return /^\d{16,25}$/.test(text) ? text : null;
}

function cleanText(value, fallback, maxLength) {
  const text = String(value ?? fallback).trim();
  return text.slice(0, maxLength);
}

function cleanTelegramChatId(value) {
  const text = String(value || '').trim();
  return /^-?\d{5,30}$/.test(text) ? text : null;
}

function parseColor(value, fallback) {
  const normalized = String(value || '').replace('#', '').trim();
  return /^[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized, 16) : fallback;
}

function renderPage() {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TeeMode Bot Dashboard</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}body{margin:0;min-height:100vh;background:radial-gradient(circle at top left,#1e3a8a,#080b12 48%,#030406);color:#f8fafc}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:36px 0}h1{font-size:clamp(34px,7vw,70px);letter-spacing:-.07em;margin:0 0 22px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}.card{background:rgba(15,23,42,.86);border:1px solid rgba(255,255,255,.1);border-radius:24px;padding:20px;box-shadow:0 20px 80px rgba(0,0,0,.35)}label{display:block;margin:13px 0 6px;color:#cbd5e1;font-size:14px}input,textarea,select{width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.14);border-radius:13px;background:#020617;color:white;padding:12px 13px;font-size:15px}textarea{min-height:88px;resize:vertical}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.check{display:flex;gap:10px;align-items:center;margin-top:12px}.check input{width:auto}button{border:0;border-radius:14px;background:#2563eb;color:white;font-weight:900;padding:13px 18px;cursor:pointer}button.secondary{background:#334155}button:hover{filter:brightness(1.1)}.muted{color:#94a3b8}.login{position:fixed;inset:0;background:rgba(0,0,0,.7);display:grid;place-items:center}.login.hidden{display:none}.login .card{width:min(500px,calc(100% - 32px))}.status{margin-left:10px;color:#86efac}.wide{grid-column:1/-1}.preview{border-left:5px solid #22d3ee;padding:12px 14px;background:#020617;border-radius:4px 14px 14px 4px;color:#e2e8f0}</style></head><body><main><h1>TeeMode Bot</h1><div class="row"><button id="save">Сохранить настройки</button><button id="logout" class="secondary">Выйти</button><span class="status" id="status"></span></div><p class="muted" id="guild"></p><section class="grid"><div class="card"><h2>Welcome / Goodbye</h2><label>Welcome channel</label><select id="welcomeChannel"></select><label>Welcome message</label><textarea id="welcomeMessage"></textarea><label>Goodbye channel</label><select id="goodbyeChannel"></select><label>Goodbye message</label><textarea id="goodbyeMessage"></textarea></div><div class="card"><h2>Logs / Autorole</h2><label>Logs channel</label><select id="logsChannel"></select><label>Auto role</label><select id="autorole"></select></div><div class="card"><h2>Moderation</h2><p class="muted">Эти роли смогут использовать /ban, /kick и /mute.</p><label>Moderator role</label><select id="moderatorRole"></select></div><div class="card"><h2>Levels</h2><label class="check"><input id="levelsEnabled" type="checkbox"> Enable levels</label><label>Level-up channel</label><select id="levelsChannel"></select></div><div class="card"><h2>Automod</h2><label class="check"><input id="automodEnabled" type="checkbox"> Enable automod</label><label>Banned words, one per line</label><textarea id="bannedWords"></textarea></div><div class="card"><h2>Telegram Bridge</h2><label class="check"><input id="telegramEnabled" type="checkbox"> Enable Telegram ↔ Discord</label><label>Discord bridge channel</label><select id="telegramChannel"></select><label>Telegram chat ID</label><input id="telegramChatId" placeholder="-1001234567890"><p class="muted">Нужен TELEGRAM_BOT_TOKEN в .env. Бота надо добавить в TG чат.</p></div><div class="card"><h2>Temporary Voice</h2><p class="muted">Пользователь заходит в trigger voice, бот создает ему отдельный войс.</p><label>Trigger voice channel</label><select id="tempTrigger"></select><label>Category for created voices</label><select id="tempCategory"></select></div><div class="card"><h2>Tickets</h2><label>Panel channel</label><select id="ticketChannel"></select><label>Ticket category</label><select id="ticketCategory"></select><label>Panel text</label><textarea id="ticketText">Нужна помощь? Создай тикет кнопкой ниже.</textarea><label>Button label</label><input id="ticketButton" value="Create ticket"><br><br><button id="sendTicket">Отправить ticket panel</button></div><div class="card wide"><h2>Bot Message / Embed</h2><p class="muted">Админы могут отправлять и редактировать сообщения бота. Цвет embed дает боковую полоску как на скрине.</p><div class="grid"><div><label>Channel</label><select id="msgChannel"></select><label>Message ID для редактирования</label><input id="msgId" placeholder="Оставь пустым для нового сообщения"><label>Plain text</label><textarea id="msgContent" placeholder="Обычный текст над embed"></textarea></div><div><label>Embed title</label><input id="msgTitle" placeholder="Заголовок"><label>Embed description</label><textarea id="msgDescription" placeholder="Текст embed"></textarea><label>Stripe color</label><input id="msgColor" value="#22d3ee"><br><br><div class="row"><button id="sendMsg">Отправить</button><button id="editMsg" class="secondary">Редактировать</button></div></div><div><label>Preview</label><div class="preview" id="preview"><strong>Заголовок</strong><br><span class="muted">Текст embed</span></div></div></div></div></section></main><div class="login" id="login"><div class="card"><h2>Discord login</h2><p class="muted">Войти может участник сервера с Administrator permission, ролью с Administrator или ролью admin/administrator/администратор.</p><button id="loginButton">Войти через Discord</button></div></div><script>
let data=null;const nl=String.fromCharCode(10);const statusEl=document.getElementById('status');document.getElementById('loginButton').onclick=()=>location.href='/auth/login';document.getElementById('logout').onclick=logout;document.getElementById('save').onclick=save;document.getElementById('sendTicket').onclick=sendTicket;document.getElementById('ticketChannel').onchange=updateTicketCategoryFromPanel;document.getElementById('ticketCategory').onchange=saveTicketCategory;document.getElementById('sendMsg').onclick=()=>sendBotMessage(false);document.getElementById('editMsg').onclick=()=>sendBotMessage(true);['msgTitle','msgDescription','msgColor'].forEach(id=>document.getElementById(id).oninput=updatePreview);handleOAuth();async function handleOAuth(){const hash=new URLSearchParams(location.hash.slice(1));if(hash.get('access_token')){const res=await fetch('/auth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken:hash.get('access_token'),state:hash.get('state')})});history.replaceState(null,'','/');if(!res.ok){alert('Discord login failed');return}location.reload();return}checkAuth()}async function checkAuth(){const me=await fetch('/api/me');if(!me.ok)return;document.getElementById('login').classList.add('hidden');load()}async function logout(){await fetch('/auth/logout',{method:'POST'});location.reload()}async function load(){const res=await fetch('/api/bootstrap');if(!res.ok){document.getElementById('login').classList.remove('hidden');return}data=await res.json();document.getElementById('guild').textContent='Server: '+data.guild.name;['welcomeChannel','goodbyeChannel','logsChannel','levelsChannel','ticketChannel','msgChannel','telegramChannel'].forEach(id=>fillSelect(id,data.channels));fillSelect('autorole',data.roles,'No role');fillSelect('moderatorRole',data.roles,'No moderator role');fillSelect('tempTrigger',data.voiceChannels,'No trigger');fillSelect('tempCategory',data.categories,'No category');fillSelect('ticketCategory',data.categories,'No category');setValue('welcomeChannel',data.config.welcome.channelId);setValue('welcomeMessage',data.config.welcome.message);setValue('goodbyeChannel',data.config.goodbye.channelId);setValue('goodbyeMessage',data.config.goodbye.message);setValue('logsChannel',data.config.logs.channelId);setValue('autorole',data.config.autorole.roleId);setValue('levelsChannel',data.config.levels.channelId);setValue('levelsEnabled',data.config.levels.enabled);setValue('automodEnabled',data.config.automod.enabled);setValue('telegramEnabled',data.config.telegram?.enabled);setValue('telegramChannel',data.config.telegram?.discordChannelId);setValue('telegramChatId',data.config.telegram?.chatId);setValue('moderatorRole',(data.config.moderation?.moderatorRoleIds||[])[0]);setValue('bannedWords',data.config.automod.bannedWords.join(nl));setValue('tempTrigger',data.config.tempvoice.triggerChannelId);setValue('tempCategory',data.config.tempvoice.categoryId);updateTicketCategoryFromPanel();updatePreview()}function fillSelect(id,items,empty='Not set'){const el=document.getElementById(id);el.innerHTML='<option value="">'+empty+'</option>'+items.map(i=>'<option value="'+esc(i.id)+'">'+esc(i.name)+'</option>').join('')}function setValue(id,value){const el=document.getElementById(id);if(el.type==='checkbox')el.checked=Boolean(value);else el.value=value||''}function getValue(id){const el=document.getElementById(id);return el.type==='checkbox'?el.checked:el.value}async function save(){const config={welcome:{channelId:getValue('welcomeChannel'),message:getValue('welcomeMessage')},goodbye:{channelId:getValue('goodbyeChannel'),message:getValue('goodbyeMessage')},logs:{channelId:getValue('logsChannel')},autorole:{roleId:getValue('autorole')},levels:{enabled:getValue('levelsEnabled'),channelId:getValue('levelsChannel')},automod:{enabled:getValue('automodEnabled'),bannedWords:getValue('bannedWords').split(nl)},moderation:{moderatorRoleIds:getValue('moderatorRole')?[getValue('moderatorRole')]:[]},telegram:{enabled:getValue('telegramEnabled'),discordChannelId:getValue('telegramChannel'),chatId:getValue('telegramChatId')},tempvoice:{triggerChannelId:getValue('tempTrigger'),categoryId:getValue('tempCategory')},tickets:{categoryId:getValue('ticketCategory')}};const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(config)});showStatus(res.ok?'Saved':'Save failed')}function updateTicketCategoryFromPanel(){const channelId=getValue('ticketChannel');const mapped=data?.config?.tickets?.panelCategories?.[channelId];setValue('ticketCategory',mapped||data?.config?.tickets?.categoryId||'')}async function saveTicketCategory(){const res=await fetch('/api/ticket-category',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId:getValue('ticketChannel'),categoryId:getValue('ticketCategory')})});showStatus(res.ok?'Ticket category saved':'Ticket category failed')}async function sendTicket(){const res=await fetch('/api/ticket-panel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId:getValue('ticketChannel'),categoryId:getValue('ticketCategory'),text:getValue('ticketText'),buttonLabel:getValue('ticketButton')})});const body=await res.json().catch(()=>({}));showStatus(res.ok?'Ticket panel sent: '+body.messageId:'Ticket failed')}async function sendBotMessage(edit){const res=await fetch('/api/bot-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channelId:getValue('msgChannel'),messageId:edit?getValue('msgId'):'',content:getValue('msgContent'),title:getValue('msgTitle'),description:getValue('msgDescription'),color:getValue('msgColor')})});const body=await res.json().catch(()=>({}));if(res.ok){setValue('msgId',body.messageId);showStatus((edit?'Edited: ':'Sent: ')+body.messageId)}else showStatus('Message failed')}function updatePreview(){const p=document.getElementById('preview');p.style.borderLeftColor=getValue('msgColor')||'#22d3ee';p.innerHTML='<strong>'+esc(getValue('msgTitle')||'Заголовок')+'</strong><br><span class="muted">'+esc(getValue('msgDescription')||'Текст embed')+'</span>'}function showStatus(text){statusEl.textContent=text;setTimeout(()=>statusEl.textContent='',3500)}function esc(v){return String(v??'').replace(/[&<>"]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s]))}
</script></body></html>`;
}
