# TeeMode Bot

Juniper-style Discord utility bot scaffold.

## Setup

```bash
npm install
cp .env.example .env
```

Fill `.env`:

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_client_id_here
DISCORD_GUILD_ID=your_test_server_id_here
```

Register slash commands:

```bash
npm run register
```

Start bot:

```bash
npm start
```

## Commands

- `/ping`
- `/help`
- `/server`
- `/user target:@user`
- `/rank target:@user`
- `/welcome set`
- `/welcome goodbye`
- `/logs set`
- `/autorole set|disable`
- `/levels enable|disable|channel`
- `/reactionrole button`
- `/ticket panel`
- `/tempvoice set`
- `/embed`
- `/automod enable|disable|addword|removeword`

## Required Developer Portal Intents

Enable these in `Bot -> Privileged Gateway Intents`:

- `Server Members Intent` for welcome/goodbye and autorole
- `Message Content Intent` for levels and automod

## Next Features

Possible Juniper-like modules:

- persistent database instead of JSON files
- dashboard
- detailed moderation actions
- ticket transcripts
