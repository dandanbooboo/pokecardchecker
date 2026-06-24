# ポケカ スレチェッカー / PokeCardChecker

Monitors three [ゲットナビ](https://gamenv.net/tc/) Pokémon-card threads and
publishes a dashboard at **https://pokecardchecker.web.app** that highlights
threads with new posts.

Watched threads:

- ヨドバシカメラ — https://gamenv.net/tc/yodobashi/#help
- ビックカメラ — https://gamenv.net/tc/biccamera/#help
- ポケモンセンター — https://gamenv.net/tc/pokesen/#help

## How it works

1. `scripts/fetcher.js` fetches each thread page (the site is WordPress +
   wpDiscuz; it sets a cookie then 302-redirects, so redirects are followed
   manually while carrying the cookie). It parses the newest comments and the
   highest comment id (the "new info" signal).
2. `scripts/build-data.js` writes `public/data.json`.
3. `public/index.html` is a static dashboard that reads `data.json` and marks a
   thread **NEW** when its latest comment id is higher than the one this browser
   last marked read (stored in `localStorage`).
4. `.github/workflows/update.yml` runs every 15 minutes, regenerates
   `data.json`, and deploys to Firebase Hosting.

## Local use

```bash
npm install
npm run build      # writes public/data.json
firebase deploy --only hosting
```

## Required GitHub secret

- `FIREBASE_TOKEN` — a Firebase CI token (`firebase login:ci`) used by the
  Action to deploy.
