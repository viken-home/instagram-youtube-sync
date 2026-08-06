// Backfill puntual: reescribe titulo/descripcion de las recopilaciones ya subidas (privadas)
// que quedaron con el titulo generico fijo "N ideas de decoracion | VIKEN Home" repetido,
// usando la misma logica que ya aplica compilation.js a las recopilaciones nuevas.
//
// Requiere que el refresh token tenga scope 'youtube' completo (lectura+escritura), no alcanza
// con 'youtube.upload'. Uso:
//   node backfill-compilation-titles.mjs            (dry run, no escribe nada)
//   node backfill-compilation-titles.mjs --apply     (aplica los cambios en YouTube)
import 'dotenv/config';
import { google } from 'googleapis';
import { buildCompilationTitle, buildCompilationDescription } from './compilation.js';

const DRY_RUN = !process.argv.includes('--apply');
const GRAPH_API_VERSION = 'v21.0';

const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN, IG_ACCESS_TOKEN, IG_USER_ID } = process.env;

function buildYoutubeClient() {
  const oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

async function fetchAllChannelVideos(youtube) {
  const ch = await youtube.channels.list({ part: ['contentDetails'], mine: true });
  const uploadsPlaylistId = ch.data.items[0].contentDetails.relatedPlaylists.uploads;

  let videoIds = [];
  let pageToken;
  do {
    const res = await youtube.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    videoIds.push(...res.data.items.map((i) => i.contentDetails.videoId));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  let all = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const res = await youtube.videos.list({ part: ['snippet', 'status'], id: batch });
    all.push(...res.data.items);
  }
  return all;
}

// Historial completo de posts de Instagram (id, caption, permalink) para resolver los captions
// reales de cada clip que entro en una recopilacion vieja. A diferencia de media_url, el caption
// no expira, asi que esto funciona aunque el reel ya no sea descargable.
async function fetchAllInstagramCaptions() {
  const fields = ['id', 'caption', 'permalink', 'timestamp'].join(',');
  let url = `https://graph.instagram.com/${GRAPH_API_VERSION}/${IG_USER_ID}/media?fields=${fields}&limit=100&access_token=${IG_ACCESS_TOKEN}`;
  const items = [];
  while (url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(`Instagram Graph API error: ${JSON.stringify(body)}`);
    items.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }
  return items;
}

async function main() {
  const youtube = buildYoutubeClient();
  const videos = await fetchAllChannelVideos(youtube);
  const igMedia = await fetchAllInstagramCaptions();
  const byPermalink = new Map(igMedia.map((m) => [m.permalink.replace(/\/$/, ''), m]));

  const compilations = videos.filter(
    (v) => v.status.privacyStatus === 'private' && v.snippet.description.includes('Posts originales:')
  );

  console.log(`Recopilaciones privadas encontradas: ${compilations.length}${DRY_RUN ? ' (dry run, pasa --apply para escribir)' : ''}`);

  let updated = 0;
  let skipped = 0;
  for (const v of compilations) {
    const description = v.snippet.description;
    const permalinks = [...description.matchAll(/https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]+\/?/g)].map((m) =>
      m[0].replace(/\/$/, '')
    );
    const items = permalinks.map((p) => ({ caption: byPermalink.get(p)?.caption ?? null, permalink: p }));

    if (items.length === 0 || items.some((i) => i.caption === null)) {
      console.log(`SKIP ${v.id}: no se pudo resolver algun caption (post borrado de Instagram?)`);
      skipped++;
      continue;
    }

    const newTitle = buildCompilationTitle(items);
    const newDescription = buildCompilationDescription(items);

    console.log(`\n${v.id} (${v.snippet.publishedAt})`);
    console.log(`  antes: ${v.snippet.title}`);
    console.log(`  ahora: ${newTitle}`);

    if (!DRY_RUN) {
      await youtube.videos.update({
        part: ['snippet'],
        requestBody: {
          id: v.id,
          snippet: { ...v.snippet, title: newTitle, description: newDescription },
        },
      });
    }
    updated++;
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Actualizados: ${updated}, saltados: ${skipped}`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
