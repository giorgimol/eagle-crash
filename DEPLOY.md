# Deploying Eagle Crash to Render (free)

Five minutes from "files on my laptop" to "URL my friend can open on his phone".
Free tier, no credit card. WebSockets work. The server will sleep after 15 min
of no traffic — but UptimeRobot at the bottom shows how to keep it warm so the
Operator P&L numbers keep growing overnight.

---

## 1. Push the code to GitHub

If you already have `gh` (GitHub CLI) installed and logged in, just:

```bash
cd /Users/giorgimolashkhia/Desktop/wings
gh repo create eagle-crash --public --source=. --remote=origin --push
```

That creates `github.com/<your-username>/eagle-crash` and pushes the code.

If you don't have `gh` installed:

1. Go to https://github.com/new — name it `eagle-crash`, public, **don't** initialize
   with README/gitignore/license (we already have them).
2. After "Create repository" GitHub shows you the URL. Copy it.
3. In your terminal:

   ```bash
   cd /Users/giorgimolashkhia/Desktop/wings
   git remote add origin <paste-the-URL-here>
   git branch -M main
   git push -u origin main
   ```

## 2. Deploy on Render

1. Go to https://dashboard.render.com/register — sign up (Google login is fastest).
2. Click **New +** → **Web Service**.
3. Choose **Build and deploy from a Git repository**.
4. Click **Connect GitHub** and pick your `eagle-crash` repo. (Public-repo URLs
   also work without OAuth — paste the URL into "Public Git repository".)
5. Render auto-detects everything from `render.yaml`:
   - Name: `eagle-crash`
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check: `/health`
   - Free plan
6. Click **Create Web Service**.

First build takes ~3 minutes. When it finishes you'll see your URL —
something like **https://eagle-crash.onrender.com** — at the top of the page.
That's the link to send your friends.

## 3. Keep the server warm overnight (optional)

Render's free tier sleeps a service after 15 minutes of no incoming traffic
and resets all in-memory state (rounds played, GGR, history). If you want the
Operator P&L numbers to still be accumulating when you wake up:

1. Go to https://uptimerobot.com/signUp — free account.
2. Click **+ Add New Monitor**.
3. Monitor type: **HTTP(s)**. URL: `https://eagle-crash.onrender.com/health`.
   Monitoring interval: **5 minutes**.
4. Click **Create Monitor**.

UptimeRobot will hit `/health` every 5 minutes. That counts as "traffic" to
Render and the service stays awake. By morning you should have ~5,000 rounds
of bot-driven economics in the Operator P&L modal (💰 icon, top right).

## 4. Sharing with friends

Just send them the URL. Each friend gets their own private balance (1000 demo
coins, in-memory). They'll see each other in the Live Feed but their bets don't
affect each other — only the bots provide shared "lobby" volume.

The Operator P&L (💰) is shared and shows the cumulative house edge across
everyone, so the more they play the more your numbers will smooth toward the
designed 97% RTP / 3% house edge.

## Common issues

**"Application failed to respond"** for the first 30s after a cold wake —
that's Render spinning up the dyno. Reload after 30s.

**"WebSocket connection failed"** — check that the URL is `https://` (Render
defaults to HTTPS). The client auto-upgrades to `wss://` when on HTTPS.

**Numbers reset to zero** — the server slept and was restarted. Set up
UptimeRobot above.

**Build fails on Render** — check the build logs. Common cause: old Node
version. The `engines.node >= 20` field in `package.json` should fix this.
