# Instagram → YouTube Sync

Sube automáticamente los Reels nuevos de @vikenhome_ (Instagram) a YouTube como video **privado** (borrador), para que Lucas los revise y publique manualmente. No publica nada solo.

## Cómo funciona

1. Cada 30-60 min, GitHub Actions corre `sync.js`.
2. El script pide los últimos posts a la Instagram Graph API, filtra los que son video, y compara contra `processed.json` para saber cuáles son nuevos.
3. Descarga el video, lo sube a YouTube (`videos.insert`, `privacyStatus: private`).
4. Marca el ID como procesado en `processed.json` (se commitea al repo).
5. Manda un mail a info.vikenhome@gmail.com con el link para revisar/publicar.

## Setup local

```
npm install
cp .env.example .env
# completar .env con las credenciales (ver más abajo)
npm run setup-youtube-auth   # una sola vez, para obtener YT_REFRESH_TOKEN
npm run sync                 # prueba manual
```

## Credenciales

- `IG_ACCESS_TOKEN` / `IG_USER_ID`: de la app de Meta for Developers vinculada a @vikenhome_ (Instagram Graph API).
- `YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN`: de un proyecto de Google Cloud con YouTube Data API v3 habilitada (ver `setup-youtube-auth.js`).
- `GMAIL_APP_PASSWORD`: App Password de Gmail para el envío de notificaciones.

## Estado

En construcción — ver plan en `C:\Users\Lucas\.claude\plans\expressive-floating-allen.md`.
