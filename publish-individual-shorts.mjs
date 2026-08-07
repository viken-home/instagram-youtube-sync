// Publica (privacyStatus -> public) los Shorts individuales (no recopilaciones) que sigan
// privados. Las recopilaciones se dejan afuera a propósito: varias tienen bloqueo de Content ID
// pendiente de resolver y son un tema aparte.
//
// Uso:
//   node publish-individual-shorts.mjs            (dry run, solo lista)
//   node publish-individual-shorts.mjs --apply     (publica de verdad)
import 'dotenv/config';
import { google } from 'googleapis';

const DRY_RUN = !process.argv.includes('--apply');
const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } = process.env;

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

async function main() {
  const youtube = buildYoutubeClient();
  const videos = await fetchAllChannelVideos(youtube);

  const isCompilation = (v) => v.snippet.description.includes('Una selección de piezas VIKEN Home');
  const individualShorts = videos.filter((v) => v.status.privacyStatus === 'private' && !isCompilation(v));
  const compilations = videos.filter((v) => v.status.privacyStatus === 'private' && isCompilation(v));

  console.log(`Shorts individuales privados a publicar: ${individualShorts.length}`);
  console.log(`Recopilaciones privadas que se dejan afuera (aparte): ${compilations.length}`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: lista de lo que se publicaria ---');
    for (const v of individualShorts) {
      console.log(`${v.id} | ${v.snippet.title} | ${v.snippet.publishedAt}`);
    }
    console.log(`\nTotal: ${individualShorts.length}. Corre con --apply para publicar de verdad.`);
    return;
  }

  let ok = 0, failed = 0;
  for (const v of individualShorts) {
    try {
      await youtube.videos.update({
        part: ['status'],
        requestBody: { id: v.id, status: { ...v.status, privacyStatus: 'public' } },
      });
      console.log(`OK: ${v.id} | ${v.snippet.title}`);
      ok++;
    } catch (err) {
      console.error(`FALLO ${v.id}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nPublicados: ${ok}, fallidos: ${failed}`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
