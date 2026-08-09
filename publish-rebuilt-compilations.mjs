// Puntual: publica (privacyStatus -> public) las recopilaciones que ya se rearmaron sin la
// portada "VIKEN HOME" (ver rebuild-compilations-without-intro.mjs), una vez que Lucas confirmo
// que ya no tienen reclamo de copyright bloqueante. Las recopilaciones VIEJAS (con portada) NO se
// tocan -- quedan privadas para siempre, reemplazadas por estas.
//
// Uso:
//   node publish-rebuilt-compilations.mjs            (dry run, no publica nada)
//   node publish-rebuilt-compilations.mjs --apply     (publica de verdad)
import 'dotenv/config';
import fs from 'node:fs';
import { google } from 'googleapis';

const DRY_RUN = !process.argv.includes('--apply');
const { YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN } = process.env;

function buildYoutubeClient() {
  const oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

async function main() {
  const state = JSON.parse(fs.readFileSync('./rebuild-state.json', 'utf-8'));
  const toPublish = state.filter((e) => e.status === 'ok');
  console.log(`${toPublish.length} recopilaciones nuevas a publicar${DRY_RUN ? ' (dry run, pasa --apply)' : ''}.`);

  if (DRY_RUN) {
    toPublish.forEach((e) => console.log(` - ${e.newId} "${e.newTitle}"`));
    return;
  }

  const youtube = buildYoutubeClient();
  let ok = 0;
  for (const e of toPublish) {
    try {
      await youtube.videos.update({
        part: ['status'],
        requestBody: {
          id: e.newId,
          status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        },
      });
      console.log(`OK: ${e.newId} -> público ("${e.newTitle}")`);
      ok++;
    } catch (err) {
      console.error(`ERROR publicando ${e.newId}:`, err.message);
    }
  }
  console.log(`\nListo: ${ok}/${toPublish.length} publicadas.`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
