// Programa los Shorts individuales privados para que se publiquen solos, uno por dia, a las
// 19:00 hora Argentina (UTC-3), empezando manana. Usa la programacion nativa de YouTube
// (status.publishAt): el video queda 'private' hasta ese instante y YouTube lo pasa a
// 'public' el solo, sin que haga falta correr nada mas ese dia.
//
// Se programan en orden cronologico real (el reel mas viejo de Instagram sale primero).
// Las recopilaciones quedan afuera, igual que en publish-individual-shorts.mjs.
//
// Uso:
//   node schedule-individual-shorts.mjs                 (dry run, solo lista las fechas)
//   node schedule-individual-shorts.mjs --apply          (programa de verdad)
//   node schedule-individual-shorts.mjs --apply --hour 19 --start 2026-08-07  (opcional)
import 'dotenv/config';
import fsp from 'node:fs/promises';
import { google } from 'googleapis';

const DRY_RUN = !process.argv.includes('--apply');
const LOG_PATH = new URL('./published-log.csv', import.meta.url);
const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } = process.env;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const HOUR = parseInt(argValue('--hour', '19'), 10);
// Por defecto, manana (hora local del servidor no importa: construimos la fecha explicita).
const startArg = argValue('--start', null);

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

// Fecha/hora en Argentina (UTC-3 fijo, sin horario de verano) para el dia N a partir del inicio.
function scheduledDateFor(startDateStr, dayOffset, hour) {
  const [y, m, d] = startDateStr.split('-').map(Number);
  // Construimos directo en UTC sumando 3 horas (Argentina = UTC-3).
  const utcMs = Date.UTC(y, m - 1, d + dayOffset, hour + 3, 0, 0);
  return new Date(utcMs);
}

function csvEscape(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

async function appendToLog(rows) {
  let existing = '';
  try {
    existing = await fsp.readFile(LOG_PATH, 'utf-8');
  } catch {
    existing = 'fecha_publicacion,video_id,titulo,link\n';
  }
  const newLines = rows
    .map((r) => `${r.date},${r.id},${csvEscape(r.title)},https://youtube.com/shorts/${r.id}`)
    .join('\n');
  await fsp.writeFile(LOG_PATH, existing + newLines + '\n');
}

async function main() {
  const youtube = buildYoutubeClient();
  const videos = await fetchAllChannelVideos(youtube);

  const isCompilation = (v) => v.snippet.description.includes('Una selección de piezas VIKEN Home');
  const individualShorts = videos
    .filter((v) => v.status.privacyStatus === 'private' && !isCompilation(v))
    .sort((a, b) => new Date(a.snippet.publishedAt) - new Date(b.snippet.publishedAt));

  const start = startArg ?? (() => {
    const t = new Date();
    t.setUTCDate(t.getUTCDate() + 1);
    return t.toISOString().slice(0, 10);
  })();

  console.log(`Shorts individuales privados a programar: ${individualShorts.length}`);
  console.log(`Empieza: ${start} a las ${HOUR}:00 (Argentina), uno por dia.\n`);

  const plan = individualShorts.map((v, i) => ({
    v,
    when: scheduledDateFor(start, i, HOUR),
  }));

  if (DRY_RUN) {
    console.log('--- DRY RUN: plan de programacion ---');
    for (const { v, when } of plan) {
      console.log(`${when.toISOString()} | ${v.id} | ${v.snippet.title}`);
    }
    const last = plan[plan.length - 1].when;
    console.log(`\nUltimo Short programado para: ${last.toISOString().slice(0, 10)}`);
    console.log('Corre con --apply para programar de verdad.');
    return;
  }

  let ok = 0, failed = 0;
  const scheduled = [];
  for (const { v, when } of plan) {
    try {
      await youtube.videos.update({
        part: ['status'],
        requestBody: {
          id: v.id,
          status: { ...v.status, privacyStatus: 'private', publishAt: when.toISOString() },
        },
      });
      console.log(`OK: ${when.toISOString().slice(0, 10)} -> ${v.id} | ${v.snippet.title}`);
      scheduled.push({ date: when.toISOString().slice(0, 10), id: v.id, title: v.snippet.title });
      ok++;
    } catch (err) {
      console.error(`FALLO ${v.id}: ${err.message}`);
      failed++;
    }
  }

  if (scheduled.length > 0) {
    await appendToLog(scheduled.map((s) => ({ ...s, date: `${s.date} (programado)` })));
  }

  console.log(`\nProgramados: ${ok}, fallidos: ${failed}`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
