// Puntual: rearma desde cero las recopilaciones ya subidas (privadas) para sacarles la portada
// "VIKEN HOME / Diseno y fabricacion propia" que compilation.js ya no genera para las nuevas
// (ver commit que saco el introCard). YouTube no permite reemplazar el archivo de un video ya
// subido, asi que la unica forma de sacar la portada es rearmar el video entero y subirlo como
// uno nuevo. NO borra las viejas: eso queda para revision manual de Lucas en Studio.
//
// Reconstruye cada recopilacion vieja a partir de los permalinks que ya estan en su descripcion
// (mismo criterio que backfill-compilation-titles.mjs), resolviendolos contra el historial
// completo de Instagram para conseguir el id real de cada media (necesario para descargarla de
// nuevo), y llama a buildAndUploadCompilation() -- la misma funcion que usa sync.js, ya sin
// intro -- para producir el video nuevo.
//
// Uso:
//   node rebuild-compilations-without-intro.mjs            (dry run, no descarga ni sube nada)
//   node rebuild-compilations-without-intro.mjs --apply     (rearma y sube de verdad)
import 'dotenv/config';
import fs from 'node:fs';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { buildAndUploadCompilation, ffmpegAvailable } from './compilation.js';
import { isCompilation, fetchAllChannelVideos } from './youtube-helpers.js';

const DRY_RUN = !process.argv.includes('--apply');
const GRAPH_API_VERSION = 'v21.0';

// Estado a prueba de cortes: si el proceso muere a mitad de camino (se corto la PC, se fue la
// luz, lo que sea), la proxima corrida retoma donde quedo en vez de rearmar y volver a subir
// las que ya estaban resueltas.
const STATE_PATH = new URL('./rebuild-state.json', import.meta.url);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function appendState(entry) {
  const state = loadState();
  state.push(entry);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

const {
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
  IG_ACCESS_TOKEN,
  IG_USER_ID,
  GMAIL_APP_PASSWORD,
  NOTIFY_EMAIL,
} = process.env;

// YouTube corta con este mensaje cuando se llega al tope diario de subidas del canal. Una vez
// que aparece, todos los intentos restantes de esta corrida van a fallar igual (es un limite de
// cuenta, no del video puntual), asi que cortamos ahi en vez de seguir gastando descargas de
// Instagram en vano.
const UPLOAD_QUOTA_MARKER = 'exceeded the number of videos';

async function notify(subject, html) {
  if (!GMAIL_APP_PASSWORD || !NOTIFY_EMAIL) {
    console.warn('GMAIL_APP_PASSWORD o NOTIFY_EMAIL no configurados: se omite el mail.');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: NOTIFY_EMAIL, pass: GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({ from: NOTIFY_EMAIL, to: NOTIFY_EMAIL, subject, html });
}

function buildYoutubeClient() {
  const oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

// Historial completo (no expira, a diferencia de media_url) para resolver el id real de cada
// permalink que aparece en la descripcion de una recopilacion vieja.
async function fetchAllInstagramMedia() {
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
  if (!DRY_RUN && !(await ffmpegAvailable())) {
    throw new Error('ffmpeg/ffprobe no disponibles en este entorno.');
  }

  const youtube = buildYoutubeClient();
  const videos = await fetchAllChannelVideos(youtube);

  const state = loadState();
  // Se omiten tanto las viejas ya resueltas (por oldId) como las nuevas que ESTE MISMO script ya
  // subio (por newId) -- estas ultimas tambien matchean isCompilation() porque comparten el mismo
  // texto fijo en la descripcion, asi que sin este segundo set el script las tomaria como "viejas"
  // y las volveria a rearmar en cadena, duplicando sin fin.
  const alreadyDone = new Set(
    state
      .filter((e) => e.status === 'ok' || e.status === 'skip_sin_clips' || e.status === 'skip_no_descargable')
      .map((e) => e.oldId)
  );
  const rebuiltIds = new Set(state.filter((e) => e.newId).map((e) => e.newId));
  if (alreadyDone.size > 0) {
    console.log(`Retomando: ${alreadyDone.size} ya resueltas en una corrida anterior, se omiten.`);
  }

  const compilations = videos.filter((v) => isCompilation(v) && !rebuiltIds.has(v.id));

  console.log(
    `Recopilaciones encontradas: ${compilations.length}${DRY_RUN ? ' (dry run, pasa --apply para rearmar y subir)' : ''}`
  );

  const igMedia = await fetchAllInstagramMedia();
  const byPermalink = new Map(igMedia.map((m) => [m.permalink.replace(/\/$/, ''), m]));

  const report = [];
  const record = (entry) => {
    report.push(entry);
    if (!DRY_RUN) appendState(entry);
  };
  let quotaBlocked = false;

  for (const v of compilations) {
    if (quotaBlocked) break;

    if (alreadyDone.has(v.id)) {
      console.log(`\n${v.id} — ya resuelta antes, se omite.`);
      continue;
    }

    const description = v.snippet.description;
    const permalinks = [
      ...description.matchAll(/https:\/\/www\.instagram\.com\/reel\/[A-Za-z0-9_-]+\/?/g),
    ].map((m) => m[0].replace(/\/$/, ''));

    const pending = permalinks.map((p) => {
      const media = byPermalink.get(p);
      return { id: media?.id ?? null, permalink: p };
    });
    const missing = pending.filter((p) => !p.id);

    console.log(`\n${v.id} — "${v.snippet.title}" (${v.status.privacyStatus}, publicado ${v.snippet.publishedAt})`);
    console.log(`  clips en la descripcion: ${pending.length}, resolubles: ${pending.length - missing.length}`);
    if (missing.length > 0) {
      console.log(`  AVISO: ${missing.length} permalink(s) ya no estan en el historial de Instagram, se omiten.`);
    }

    const usable = pending.filter((p) => p.id);
    if (usable.length === 0) {
      console.log('  SKIP: ningun clip resoluble, no se puede rearmar.');
      record({ oldId: v.id, oldTitle: v.snippet.title, status: 'skip_sin_clips' });
      continue;
    }

    if (DRY_RUN) {
      report.push({ oldId: v.id, oldTitle: v.snippet.title, status: 'dry_run', clips: usable.length });
      continue;
    }

    try {
      const { youtubeId, title, usedIds, deadIds } = await buildAndUploadCompilation({
        pending: usable,
        batchSize: usable.length,
        accessToken: IG_ACCESS_TOKEN,
        youtube,
      });

      if (!youtubeId) {
        console.log('  SKIP: no quedaron clips descargables al momento de rearmar.');
        record({ oldId: v.id, oldTitle: v.snippet.title, status: 'skip_no_descargable' });
        continue;
      }

      console.log(`  OK -> nuevo video: https://studio.youtube.com/video/${youtubeId}/edit ("${title}")`);
      if (deadIds.length > 0) {
        console.log(`  (${deadIds.length} clip(s) descartados al descargar, quedo con ${usedIds.length})`);
      }
      record({
        oldId: v.id,
        oldTitle: v.snippet.title,
        newId: youtubeId,
        newTitle: title,
        status: 'ok',
        clipsUsados: usedIds.length,
        clipsDescartados: deadIds.length,
      });
    } catch (err) {
      console.error(`  ERROR rearmando ${v.id}:`, err.message);
      record({ oldId: v.id, oldTitle: v.snippet.title, status: 'error', error: err.message });
      if (err.message.includes(UPLOAD_QUOTA_MARKER)) {
        console.warn('  Tope diario de subidas de YouTube alcanzado, se corta el resto de esta corrida.');
        quotaBlocked = true;
      }
    }
  }

  const finalState = DRY_RUN ? report : loadState();
  console.log('\n=== RESUMEN (incluye corridas anteriores retomadas) ===');
  console.log(JSON.stringify(finalState, null, 2));

  if (!DRY_RUN) {
    const ok = finalState.filter((e) => e.status === 'ok');
    const skipped = finalState.filter((e) => e.status === 'skip_sin_clips' || e.status === 'skip_no_descargable');
    const errored = finalState.filter((e) => e.status === 'error');
    const totalCompilationsOnChannel = ok.length + skipped.length + errored.length;
    const pending = 22 - totalCompilationsOnChannel; // 22 = total de recopilaciones a rearmar

    const rows = (list, label) =>
      list.length === 0
        ? ''
        : `<p><b>${label} (${list.length}):</b></p><ul>${list
            .map((e) => `<li>${e.oldTitle}${e.newId ? ` → <a href="https://studio.youtube.com/video/${e.newId}/edit">nueva</a>` : ''}${e.error ? ` — ${e.error}` : ''}</li>`)
            .join('')}</ul>`;

    const subject = quotaBlocked
      ? `⏸ Reconstrucción de recopilaciones frenada de nuevo por cupo (${ok.length}/22 completas)`
      : pending > 0
      ? `🔄 Reconstrucción de recopilaciones: ${ok.length}/22 listas, sigue pendiente`
      : `✅ Reconstrucción de recopilaciones terminada: ${ok.length}/22 sin portada`;

    const html =
      `<p>Resultado acumulado de sacarle la portada "VIKEN HOME" a las recopilaciones viejas:</p>` +
      `<p>OK: ${ok.length} · Sin clips disponibles en Instagram: ${skipped.length} · Con error: ${errored.length}</p>` +
      (quotaBlocked
        ? '<p><b>Se volvió a topar con el límite diario de subidas de YouTube.</b> Va a reintentar solo mañana a la misma hora.</p>'
        : '') +
      rows(ok, 'Rearmadas OK') +
      rows(skipped, 'Sin clips (Instagram ya no las sirve)') +
      rows(errored, 'Con error');

    await notify(subject, html).catch((err) => console.warn('No se pudo mandar el mail:', err.message));
  }
}

main().catch(async (err) => {
  console.error('Error fatal:', err);
  await notify('❌ Error fatal reconstruyendo recopilaciones', `<p>${err.message}</p>`).catch(() => {});
  process.exit(1);
});
