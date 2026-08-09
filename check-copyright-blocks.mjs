// Corre 1 vez por dia (GitHub Actions) y avisa por mail si aparece un bloqueo de Content ID nuevo
// en cualquier video del canal, o un video rechazado (huelga de comunidad, etc.).
//
// El bloqueo de Content ID NO aparece en status.rejectionReason (queda vacio, confirmado a mano
// contra un video que sabemos bloqueado) -- la unica senal real via la Data API publica es
// contentDetails.regionRestriction.blocked con una lista larga de paises (practicamente bloqueo
// mundial). Se usa >50 paises bloqueados como umbral para no confundir con una restriccion
// geografica chica y deliberada (que no usamos, pero por las dudas).
//
// Guarda en copyright-check-state.json que IDs ya se avisaron, para no mandar el mismo mail todos
// los dias mientras el problema siga sin resolver -- solo avisa cuando aparece algo NUEVO.
import 'dotenv/config';
import fs from 'node:fs';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { fetchAllChannelVideos } from './youtube-helpers.js';

const REGION_BLOCK_THRESHOLD = 50;
const STATE_PATH = './copyright-check-state.json';

const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN, GMAIL_APP_PASSWORD, NOTIFY_EMAIL } = process.env;

function buildYoutubeClient() {
  const oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { notifiedBlocked: [], notifiedRejected: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function sendAlert({ newlyBlocked, newlyRejected, stillBlocked }) {
  if (!GMAIL_APP_PASSWORD || !NOTIFY_EMAIL) {
    console.warn('GMAIL_APP_PASSWORD o NOTIFY_EMAIL no configurados: se omite el mail.');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: NOTIFY_EMAIL, pass: GMAIL_APP_PASSWORD },
  });

  const rows = (list, label) =>
    list.length === 0
      ? ''
      : `<p><b>${label}:</b></p><ul>${list
          .map((v) => `<li><a href="https://studio.youtube.com/video/${v.id}/edit">${v.title}</a></li>`)
          .join('')}</ul>`;

  const html =
    `<p>Chequeo diario del canal @vikenhome encontró algo para revisar:</p>` +
    rows(newlyBlocked, '🚫 Bloqueados por Content ID (nuevo hoy)') +
    rows(newlyRejected, '⚠️ Rechazados (nuevo hoy)') +
    (stillBlocked.length > 0
      ? `<p style="color:#888">(Siguen bloqueados desde antes, ya avisados: ${stillBlocked.length})</p>`
      : '');

  await transporter.sendMail({
    from: NOTIFY_EMAIL,
    to: NOTIFY_EMAIL,
    subject: `⚠️ ${newlyBlocked.length + newlyRejected.length} video(s) nuevo(s) con problema en YouTube`,
    html,
  });
}

async function main() {
  const youtube = buildYoutubeClient();
  const videos = await fetchAllChannelVideos(youtube);
  const state = loadState();
  const notifiedBlocked = new Set(state.notifiedBlocked ?? []);
  const notifiedRejected = new Set(state.notifiedRejected ?? []);

  const blocked = videos.filter(
    (v) => (v.contentDetails?.regionRestriction?.blocked?.length ?? 0) > REGION_BLOCK_THRESHOLD
  );
  const rejected = videos.filter((v) => v.status.uploadStatus === 'rejected');

  const newlyBlocked = blocked.filter((v) => !notifiedBlocked.has(v.id));
  const newlyRejected = rejected.filter((v) => !notifiedRejected.has(v.id));
  const stillBlocked = blocked.filter((v) => notifiedBlocked.has(v.id));

  console.log(`Bloqueados por Content ID: ${blocked.length} (${newlyBlocked.length} nuevo(s))`);
  console.log(`Rechazados: ${rejected.length} (${newlyRejected.length} nuevo(s))`);

  if (newlyBlocked.length > 0 || newlyRejected.length > 0) {
    await sendAlert({
      newlyBlocked: newlyBlocked.map((v) => ({ id: v.id, title: v.snippet.title })),
      newlyRejected: newlyRejected.map((v) => ({ id: v.id, title: v.snippet.title })),
      stillBlocked,
    });
  }

  // Se guarda EXACTAMENTE el set actual de bloqueados/rechazados (no se acumula para siempre):
  // si un video se destraba y despues se vuelve a bloquear, tiene que avisar de nuevo.
  saveState({
    notifiedBlocked: blocked.map((v) => v.id),
    notifiedRejected: rejected.map((v) => v.id),
  });
}

main().catch(async (err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
