import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { COMPILATION_BATCH_SIZE, ffmpegAvailable, buildAndUploadCompilation } from './compilation.js';
import { sanitizeForYoutube, truncateTitle, buildDescription } from './text-utils.js';
import { isCompilation, fetchAllChannelVideos, computeNextSlotFromVideos } from './youtube-helpers.js';

const {
  IG_ACCESS_TOKEN,
  IG_USER_ID,
  YT_CLIENT_ID,
  YT_CLIENT_SECRET,
  YT_REFRESH_TOKEN,
  GMAIL_APP_PASSWORD,
  NOTIFY_EMAIL,
} = process.env;

const PROCESSED_PATH = new URL('./processed.json', import.meta.url);
const GRAPH_API_VERSION = 'v21.0';

function requireEnv(vars) {
  const missing = vars.filter((v) => !process.env[v]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(', ')}`);
  }
}

async function loadProcessed() {
  const raw = await fsp.readFile(PROCESSED_PATH, 'utf-8');
  const data = JSON.parse(raw);
  return {
    processedIds: data.processedIds ?? [],
    pendingCompilation: data.pendingCompilation ?? [],
    notifiedPublished: data.notifiedPublished ?? [],
  };
}

async function saveProcessed(data) {
  await fsp.writeFile(PROCESSED_PATH, JSON.stringify(data, null, 2) + '\n');
}

async function fetchInstagramReels() {
  const fields = [
    'id',
    'caption',
    'media_type',
    'media_product_type',
    'media_url',
    'permalink',
    'timestamp',
  ].join(',');

  let url =
    `https://graph.instagram.com/${GRAPH_API_VERSION}/${IG_USER_ID}/media` +
    `?fields=${fields}&limit=100&access_token=${IG_ACCESS_TOKEN}`;

  const items = [];
  while (url) {
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`Instagram Graph API error: ${JSON.stringify(body)}`);
    }
    items.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }

  return items
    .filter((item) => item.media_product_type === 'REELS' || item.media_type === 'VIDEO')
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // más viejo primero
}

async function downloadVideo(mediaUrl, destPath) {
  const res = await fetch(mediaUrl);
  if (!res.ok || !res.body) {
    throw new Error(`No se pudo descargar el video (HTTP ${res.status})`);
  }
  await fsp.writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

function buildYoutubeClient() {
  const oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

const TAGS = [
  'VikenHome', 'Decoracion', 'Hogar', 'Impresion 3D', 'Diseño de interiores',
  'Decoracion Argentina', 'Objetos decorativos', 'Macetas', 'Floreros', 'Jarrones',
  'Portavelas', 'Velas decorativas', 'Decoracion minimalista', 'Decoracion boho',
  'Home Decor', '3D Printing', 'Handmade', 'Taller propio', 'Diseño artesanal',
  'Decoracion moderna', 'Decoracion living', 'Regalos originales', 'Shorts',
  'DIY decoracion', 'Buenos Aires', 'Argentina', 'Piezas decorativas',
  'Decoracion nordica', 'Ambientacion', 'Interiorismo',
];

function buildTitle(caption, timestamp) {
  const fallback = `Reel de Instagram - ${new Date(timestamp).toLocaleDateString('es-AR')}`;
  if (!caption) return fallback;
  const firstLine = sanitizeForYoutube(caption.split('\n')[0].trim());
  const title = firstLine || fallback;
  return truncateTitle(title);
}

async function uploadToYoutube(youtube, { filePath, title, description, publishAt }) {
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags: TAGS,
        defaultLanguage: 'es',
        defaultAudioLanguage: 'es',
      },
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids: false,
        // Programado: YouTube lo hace publico solo en esta fecha, sin que haga falta correr
        // nada mas ese dia. Uno por dia, para no volcar todo junto (ver nextAvailableSlot).
        ...(publishAt ? { publishAt: publishAt.toISOString() } : {}),
      },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  return res.data.id;
}

function buildEmailSection(title, items) {
  if (items.length === 0) return '';
  const listHtml = items
    .map(
      (item) =>
        `<li><a href="https://studio.youtube.com/video/${item.youtubeId}/edit">${item.title}</a>` +
        (item.permalink ? ` (<a href="${item.permalink}">post original</a>)` : '') +
        (item.publishAt ? ` — se publica solo el ${item.publishAt.slice(0, 10)}` : '') +
        '</li>'
    )
    .join('');
  return `<p>${title}</p><ul>${listHtml}</ul>`;
}

async function sendNotificationEmail(uploaded, compilations) {
  if (!GMAIL_APP_PASSWORD || !NOTIFY_EMAIL) {
    console.warn('GMAIL_APP_PASSWORD o NOTIFY_EMAIL no configurados: se omite el mail.');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: NOTIFY_EMAIL, pass: GMAIL_APP_PASSWORD },
  });

  const html =
    '<p>Novedades subidas a YouTube. Los Shorts individuales ya quedaron programados para publicarse solos ' +
    'en su fecha; las recopilaciones quedan privadas para que las revises y publiques manualmente:</p>' +
    buildEmailSection('Reels individuales (programados):', uploaded) +
    buildEmailSection('Recopilaciones (revisar manualmente):', compilations);

  const total = uploaded.length + compilations.length;
  await transporter.sendMail({
    from: NOTIFY_EMAIL,
    to: NOTIFY_EMAIL,
    subject: `${total} video(s) nuevo(s) subido(s) a YouTube como borrador`,
    html,
  });
}

// Avisa cuando un Short programado se hizo publico solo (YouTube lo publica el mismo en la
// fecha de publishAt, sin que este script tenga que correr en ese instante exacto). Como sync.js
// corre cada 30-60 min, el aviso llega poco despues de que efectivamente salio.
async function sendPublishedConfirmationEmail(videos) {
  if (!GMAIL_APP_PASSWORD || !NOTIFY_EMAIL) {
    console.warn('GMAIL_APP_PASSWORD o NOTIFY_EMAIL no configurados: se omite el mail.');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: NOTIFY_EMAIL, pass: GMAIL_APP_PASSWORD },
  });

  const listHtml = videos
    .map((v) => `<li><a href="https://youtube.com/shorts/${v.id}">${v.snippet.title}</a></li>`)
    .join('');

  await transporter.sendMail({
    from: NOTIFY_EMAIL,
    to: NOTIFY_EMAIL,
    subject: `✅ ${videos.length} Short(s) publicado(s) hoy en YouTube`,
    html: `<p>Se publicaron solos, tal como estaban programados:</p><ul>${listHtml}</ul>`,
  });
}

async function main() {
  requireEnv([
    'IG_ACCESS_TOKEN',
    'IG_USER_ID',
    'YT_CLIENT_ID',
    'YT_CLIENT_SECRET',
    'YT_REFRESH_TOKEN',
  ]);

  const processed = await loadProcessed();
  const processedIds = new Set(processed.processedIds);
  const pendingCompilation = [...processed.pendingCompilation];
  const notifiedPublished = new Set(processed.notifiedPublished);

  const persist = () =>
    saveProcessed({
      processedIds: [...processedIds],
      pendingCompilation,
      notifiedPublished: [...notifiedPublished],
    });

  const reels = await fetchInstagramReels();
  const newReels = reels.filter((r) => !processedIds.has(r.id));

  const youtube = buildYoutubeClient();
  const uploaded = [];

  // Foto del estado real del canal al arrancar: sirve tanto para saber donde sigue la cola de
  // programacion como para detectar que se hizo publico desde la corrida anterior.
  const channelVideos = await fetchAllChannelVideos(youtube);

  if (newReels.length === 0) {
    console.log('No hay reels nuevos.');
  } else {
    console.log(`Encontrados ${newReels.length} reel(s) nuevo(s).`);

    // Cada reel nuevo se programa al final de la cola diaria (uno por dia, 19:00 ARG) en vez de
    // quedar privado sin fecha. El cursor arranca en el proximo turno libre segun lo que ya haya
    // programado, y avanza un dia por cada reel de esta misma corrida.
    let nextSlot = computeNextSlotFromVideos(channelVideos);

    for (const reel of newReels) {
      const tmpFile = path.join(os.tmpdir(), `${reel.id}.mp4`);
      try {
        console.log(`Descargando ${reel.id}...`);
        await downloadVideo(reel.media_url, tmpFile);

        const title = buildTitle(reel.caption, reel.timestamp);
        const description = buildDescription(reel.caption, reel.permalink);
        const publishAt = nextSlot;

        console.log(`Subiendo ${reel.id} a YouTube (se publica solo el ${publishAt.toISOString().slice(0, 10)})...`);
        const youtubeId = await uploadToYoutube(youtube, { filePath: tmpFile, title, description, publishAt });

        uploaded.push({ youtubeId, title, permalink: reel.permalink, publishAt: publishAt.toISOString() });

        processedIds.add(reel.id);
        pendingCompilation.push({ id: reel.id, permalink: reel.permalink });
        await persist();
        console.log(`OK: ${reel.id} -> https://studio.youtube.com/video/${youtubeId}/edit`);

        nextSlot = new Date(nextSlot);
        nextSlot.setUTCDate(nextSlot.getUTCDate() + 1);
      } catch (err) {
        console.error(`Error procesando ${reel.id}:`, err.message);
      } finally {
        await fsp.rm(tmpFile, { force: true });
      }
    }
  }

  const compilations = [];
  if (pendingCompilation.length >= COMPILATION_BATCH_SIZE) {
    if (await ffmpegAvailable()) {
      while (pendingCompilation.length >= COMPILATION_BATCH_SIZE) {
        console.log(`Armando recopilación con hasta ${COMPILATION_BATCH_SIZE} reels...`);
        try {
          const { youtubeId, title, usedIds, deadIds } = await buildAndUploadCompilation({
            pending: pendingCompilation,
            batchSize: COMPILATION_BATCH_SIZE,
            accessToken: IG_ACCESS_TOKEN,
            youtube,
          });

          if (deadIds.length > 0) {
            console.warn(`${deadIds.length} reel(s) descartados de la cola (ya no disponibles en Instagram): ${deadIds.join(', ')}`);
          }
          const consumed = new Set([...(usedIds ?? []), ...(deadIds ?? [])]);
          for (let i = pendingCompilation.length - 1; i >= 0; i--) {
            if (consumed.has(pendingCompilation[i].id)) pendingCompilation.splice(i, 1);
          }
          await persist();

          if (youtubeId) {
            compilations.push({ youtubeId, title });
            console.log(`OK recopilación: ${title} -> https://studio.youtube.com/video/${youtubeId}/edit`);
          } else {
            console.log('No quedaron reels descargables en este lote, se omite la recopilación.');
          }
        } catch (err) {
          console.error('Error armando recopilación:', err.message);
          break;
        }
      }
    } else {
      console.warn('ffmpeg no disponible: se omite la recopilación por ahora.');
    }
  }

  if (uploaded.length > 0 || compilations.length > 0) {
    await sendNotificationEmail(uploaded, compilations);
  }

  // Shorts que ya estaban programados y, desde la corrida anterior, YouTube los hizo publicos
  // solo (no hace falta que este script corra justo a las 19:00, el aviso llega en la siguiente
  // pasada del cron). channelVideos es la foto de ANTES de subir nada en esta corrida, asi que
  // nunca confunde un upload de recien con una publicacion real.
  const newlyPublic = channelVideos.filter(
    (v) => v.status.privacyStatus === 'public' && !isCompilation(v) && !notifiedPublished.has(v.id)
  );
  if (newlyPublic.length > 0) {
    console.log(`${newlyPublic.length} Short(s) se publicaron solos desde la corrida anterior.`);
    await sendPublishedConfirmationEmail(newlyPublic);
    for (const v of newlyPublic) notifiedPublished.add(v.id);
    await persist();
  }
}

main().catch((err) => {
  console.error('Error fatal en sync:', err);
  process.exit(1);
});
