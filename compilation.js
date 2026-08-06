import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const GRAPH_API_VERSION = 'v21.0';
const WIDTH = 1080;
const HEIGHT = 1920;
const CARD_DURATION = 1.2;
const TRANSITION = 0.4;
const FONT = process.platform === 'darwin' ? '/System/Library/Fonts/Helvetica.ttc' : 'DejaVu Sans';
const FONT_ARG = process.platform === 'darwin' ? `fontfile=${FONT}` : `font=${FONT}`;

export const COMPILATION_BATCH_SIZE = 5;

export async function ffmpegAvailable() {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    await execFileAsync('ffprobe', ['-version']);
    return true;
  } catch {
    return false;
  }
}

async function getDuration(file) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    file,
  ]);
  return parseFloat(stdout.trim());
}

async function fetchMediaById(id, accessToken) {
  const fields = 'media_url,caption,permalink,timestamp';
  const url = `https://graph.instagram.com/${GRAPH_API_VERSION}/${id}?fields=${fields}&access_token=${accessToken}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(`Instagram API error (${id}): ${JSON.stringify(body)}`);
  return body;
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`No se pudo descargar (HTTP ${res.status})`);
  await fsp.writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function normalizeClip(input, output) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-i', input,
    '-vf',
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1,fps=30`,
    '-c:v', 'libx264', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-pix_fmt', 'yuv420p',
    output,
  ]);
}

function escapeDrawtext(text) {
  return text.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

async function buildCard(text, subtext, output) {
  const lines = [
    `drawtext=text='${escapeDrawtext(text)}':fontcolor=black:fontsize=100:${FONT_ARG}:x=(w-text_w)/2:y=(h-text_h)/2-50`,
  ];
  if (subtext) {
    lines.push(
      `drawtext=text='${escapeDrawtext(subtext)}':fontcolor=gray:fontsize=48:${FONT_ARG}:x=(w-text_w)/2:y=(h-text_h)/2+60`
    );
  }
  // fps=30 para que coincida con el timebase de los clips normalizados (si no, xfade falla con
  // "First input link main timebase do not match the corresponding second input link xfade timebase").
  lines.push('fps=30');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', `color=c=white:s=${WIDTH}x${HEIGHT}:d=${CARD_DURATION}`,
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-vf', lines.join(','),
    '-t', String(CARD_DURATION),
    '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p',
    '-shortest',
    output,
  ]);
}

async function concatenateWithTransitions(segments, outputPath) {
  const inputs = segments.flatMap((s) => ['-i', s.file]);
  let videoLabel = '0:v';
  let audioLabel = '0:a';
  let total = segments[0].duration;
  const filterParts = [];

  for (let i = 1; i < segments.length; i++) {
    const offset = Math.max(total - TRANSITION, 0);
    const nextV = `v${i}`;
    const nextA = `a${i}`;
    filterParts.push(
      `[${videoLabel}][${i}:v]xfade=transition=fade:duration=${TRANSITION}:offset=${offset.toFixed(3)}[${nextV}]`
    );
    filterParts.push(`[${audioLabel}][${i}:a]acrossfade=d=${TRANSITION}[${nextA}]`);
    videoLabel = nextV;
    audioLabel = nextA;
    total = total + segments[i].duration - TRANSITION;
  }

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', `[${videoLabel}]`,
      '-map', `[${audioLabel}]`,
      '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p',
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 * 100 }
  );
}

function buildCompilationDescription(permalinks) {
  const list = permalinks.map((p) => `• ${p}`).join('\n');
  return [
    'Una selección de piezas VIKEN Home 🏠 — diseñamos y fabricamos nosotros mismos cada una, en nuestro propio taller.',
    '',
    '¿Querés armar tu rincón? Te asesoramos 1:1 por Instagram.',
    '',
    '📷 Instagram: https://www.instagram.com/vikenhome_',
    '🛒 Comprá acá: https://www.viken.com.ar',
    '',
    'Posts originales:',
    list,
    '',
    '#VikenHome #Decoracion #Hogar',
  ].join('\n');
}

async function uploadCompilation(youtube, { filePath, title, description }) {
  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags: [
          'VikenHome', 'Decoracion', 'Hogar', 'Recopilacion', 'Impresion 3D',
          'Diseño de interiores', 'Decoracion Argentina', 'Objetos decorativos',
          'Home Decor', 'Handmade', 'Taller propio', 'Shorts',
        ],
        defaultLanguage: 'es',
        defaultAudioLanguage: 'es',
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    },
    media: { body: fs.createReadStream(filePath) },
  });
  return res.data.id;
}

// Recorre `pending` en orden y junta hasta `batchSize` clips descargables. Los items cuyo
// media_url ya no esta disponible en Instagram (pasan las ~2-3 semanas y la API deja de
// servirlo) se reportan en `deadIds` para que el llamador los descarte de la cola para
// siempre, en vez de trabar el armado de recopilaciones indefinidamente.
export async function buildAndUploadCompilation({ pending, batchSize, accessToken, youtube }) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'viken-compilation-'));
  try {
    const segments = [];
    const usedIds = [];
    const deadIds = [];
    const permalinks = [];

    const introCard = path.join(workDir, 'intro.mp4');
    await buildCard('VIKEN HOME', 'Diseno y fabricacion propia', introCard);
    segments.push({ file: introCard, duration: CARD_DURATION });

    for (const item of pending) {
      if (usedIds.length >= batchSize) break;
      let media;
      try {
        media = await fetchMediaById(item.id, accessToken);
      } catch (err) {
        console.warn(`Reel ${item.id} ya no se puede leer de Instagram, se descarta: ${err.message}`);
        deadIds.push(item.id);
        continue;
      }
      if (!media.media_url) {
        console.warn(`Reel ${item.id} perdio su media_url en Instagram, se descarta.`);
        deadIds.push(item.id);
        continue;
      }

      const i = usedIds.length;
      const raw = path.join(workDir, `raw-${i}.mp4`);
      const normalized = path.join(workDir, `clip-${i}.mp4`);
      await downloadFile(media.media_url, raw);
      await normalizeClip(raw, normalized);
      const duration = await getDuration(normalized);
      segments.push({ file: normalized, duration });
      permalinks.push(media.permalink ?? item.permalink);
      usedIds.push(item.id);
    }

    if (usedIds.length === 0) {
      return { youtubeId: null, title: null, usedIds, deadIds };
    }

    const outroCard = path.join(workDir, 'outro.mp4');
    await buildCard('Seguinos', '@vikenhome_ en Instagram', outroCard);
    segments.push({ file: outroCard, duration: CARD_DURATION });

    const output = path.join(workDir, 'compilation.mp4');
    await concatenateWithTransitions(segments, output);

    const title = `${usedIds.length} ideas de decoracion | VIKEN Home`;
    const description = buildCompilationDescription(permalinks);
    const youtubeId = await uploadCompilation(youtube, { filePath: output, title, description });

    return { youtubeId, title, usedIds, deadIds };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}
