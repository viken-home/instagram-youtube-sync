import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { COMPILATION_BATCH_SIZE, ffmpegAvailable, buildAndUploadCompilation } from './compilation.js';

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
  return { processedIds: data.processedIds ?? [], pendingCompilation: data.pendingCompilation ?? [] };
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

const MAX_TITLE_LENGTH = 95;

const BRAND_FOOTER = [
  'VIKEN Home 🏠 diseñamos y fabricamos nosotros mismos cada pieza de decoración — no es catálogo genérico, es taller propio, así que lo que ves acá no lo conseguís en otro lado.',
  '',
  '¿Querés armar tu rincón? Te asesoramos 1:1 por Instagram.',
  '',
  '📷 Instagram: https://www.instagram.com/vikenhome_',
  '🛒 Comprá acá: https://www.viken.com.ar',
].join('\n');

const HASHTAGS = '#VikenHome #Decoracion #Hogar #Shorts';
const TAGS = ['VikenHome', 'Decoracion', 'Hogar', 'Shorts'];

function sanitizeForYoutube(text) {
  // YouTube rechaza < y > en título/descripción (error "invalid video description").
  return text.replace(/>/g, '→').replace(/</g, '‹');
}

function buildTitle(caption, timestamp) {
  const fallback = `Reel de Instagram - ${new Date(timestamp).toLocaleDateString('es-AR')}`;
  if (!caption) return fallback;
  const firstLine = sanitizeForYoutube(caption.split('\n')[0].trim());
  const title = firstLine || fallback;
  if (title.length <= MAX_TITLE_LENGTH) return title;
  const cut = title.slice(0, MAX_TITLE_LENGTH - 3);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : cut.length)}...`;
}

function buildDescription(caption, permalink) {
  const body = [caption, '', BRAND_FOOTER, '', `Post original: ${permalink}`, '', HASHTAGS]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
  return sanitizeForYoutube(body);
}

async function uploadToYoutube(youtube, { filePath, title, description }) {
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description, tags: TAGS },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
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
    '<p>Novedades subidas a YouTube como video privado. Revisalas y publicalas manualmente desde YouTube Studio:</p>' +
    buildEmailSection('Reels individuales:', uploaded) +
    buildEmailSection('Recopilaciones:', compilations);

  const total = uploaded.length + compilations.length;
  await transporter.sendMail({
    from: NOTIFY_EMAIL,
    to: NOTIFY_EMAIL,
    subject: `${total} video(s) nuevo(s) subido(s) a YouTube como borrador`,
    html,
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

  const persist = () =>
    saveProcessed({ processedIds: [...processedIds], pendingCompilation });

  const reels = await fetchInstagramReels();
  const newReels = reels.filter((r) => !processedIds.has(r.id));

  const youtube = buildYoutubeClient();
  const uploaded = [];

  if (newReels.length === 0) {
    console.log('No hay reels nuevos.');
  } else {
    console.log(`Encontrados ${newReels.length} reel(s) nuevo(s).`);

    for (const reel of newReels) {
      const tmpFile = path.join(os.tmpdir(), `${reel.id}.mp4`);
      try {
        console.log(`Descargando ${reel.id}...`);
        await downloadVideo(reel.media_url, tmpFile);

        const title = buildTitle(reel.caption, reel.timestamp);
        const description = buildDescription(reel.caption, reel.permalink);

        console.log(`Subiendo ${reel.id} a YouTube...`);
        const youtubeId = await uploadToYoutube(youtube, { filePath: tmpFile, title, description });

        uploaded.push({ youtubeId, title, permalink: reel.permalink });

        processedIds.add(reel.id);
        pendingCompilation.push({ id: reel.id, permalink: reel.permalink });
        await persist();
        console.log(`OK: ${reel.id} -> https://studio.youtube.com/video/${youtubeId}/edit`);
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
        const batch = pendingCompilation.slice(0, COMPILATION_BATCH_SIZE);
        console.log(`Armando recopilación con ${batch.length} reels...`);
        try {
          const { youtubeId, title } = await buildAndUploadCompilation({
            batch,
            accessToken: IG_ACCESS_TOKEN,
            youtube,
          });
          compilations.push({ youtubeId, title });
          pendingCompilation.splice(0, COMPILATION_BATCH_SIZE);
          await persist();
          console.log(`OK recopilación: ${title} -> https://studio.youtube.com/video/${youtubeId}/edit`);
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
}

main().catch((err) => {
  console.error('Error fatal en sync:', err);
  process.exit(1);
});
