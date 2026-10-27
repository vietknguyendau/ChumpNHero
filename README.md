# Chump & Hero 🎳

Bowling tracker for the team. Each game, top score is the Hero, bottom score is the Chump.
Everyone with the link can enter scores, and it refreshes every 20 seconds so the team sees updates.

## Deploy to Vercel (about 10 minutes)

1. **Put the code on GitHub.** Create a new repo (e.g. `chump-hero`) and upload these files,
   keeping the `api` folder: `index.html`, `api/state.js`, `package.json`, `README.md`.
2. **Import into Vercel.** vercel.com → Add New → Project → pick the repo → Deploy.
   No build settings needed.
3. **Add the database.** In the project: Storage tab → Create Database → choose
   **Upstash for Redis** (free tier is plenty) → connect it to this project.
   This adds the `KV_REST_API_URL` and `KV_REST_API_TOKEN` environment variables for you.
4. **(Optional) Add a team PIN** so random people with the link can't edit:
   Settings → Environment Variables → add `TEAM_PIN` = something like `strike42`.
   Anyone can still view; saving asks for the PIN once per phone.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect.
6. Send the `.vercel.app` link to the team. On iPhone: Share → Add to Home Screen
   and it opens like an app.

## Files
- `index.html` – the app
- `api/state.js` – saves and loads scores from Redis
- `package.json` – one dependency (`@upstash/redis`)

## Prefer the command line?
```
npm i -g vercel
vercel          # first deploy
vercel --prod   # after adding the database
```
