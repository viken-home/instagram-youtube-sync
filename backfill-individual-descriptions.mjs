// Backfill puntual: los primeros Shorts individuales que subio el pipeline (6 jul 2026) se
// generaron con una version vieja de sync.js que no tenia el bloque de marca (Instagram, web,
// asesoria 1:1) en la descripcion, solo "Original: <link>" pelado. Este script los detecta
// (por privados, no-recopilacion, sin el texto "Te asesoramos 1:1") y les reescribe la
// descripcion con la logica actual (buildDescription de text-utils.js), usando el caption real
// de Instagram (por permalink, no expira como media_url).
//
// Uso:
//   node backfill-individual-descriptions.mjs            (dry run)
//   node backfill-individual-descriptions.mjs --apply     (aplica los cambios)
import 'dotenv/config';
import { google } from 'googleapis';
import { buildDescription } from './text-utils.js';
import { isCompilation, fetchAllChannelVideos } from './youtube-helpers.js';

const DRY_RUN = !process.argv.includes('--apply');
const GRAPH_API_VERSION = 'v21.0';
const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN, IG_ACCESS_TOKEN, IG_USER_ID } = process.env;

function buildYoutubeClient() {
  const oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

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

  const targets = videos.filter(
    (v) =>
      v.status.privacyStatus === 'private' &&
      !isCompilation(v) &&
      !v.snippet.description.includes('Te asesoramos 1:1')
  );

  console.log(`Shorts individuales con formato viejo: ${targets.length}`);

  let updated = 0, skipped = 0;
  for (const v of targets) {
    const match = v.snippet.description.match(/https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]+\/?/);
    const permalink = match?.[0]?.replace(/\/$/, '');
    const media = permalink ? byPermalink.get(permalink) : null;

    if (!media) {
      console.log(`SKIP ${v.id}: no se encontro el permalink/caption original`);
      skipped++;
      continue;
    }

    const newDescription = buildDescription(media.caption, media.permalink);

    console.log(`\n${v.id} | ${v.snippet.title}`);
    console.log(`  descripcion nueva (${newDescription.length} chars)`);

    if (!DRY_RUN) {
      await youtube.videos.update({
        part: ['snippet'],
        requestBody: {
          id: v.id,
          snippet: { ...v.snippet, description: newDescription },
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
