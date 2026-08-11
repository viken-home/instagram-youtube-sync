// Puntual: saca "Home" de "VIKEN Home" en titulo/descripcion de TODOS los videos ya subidos
// (individuales programados/publicados + recopilaciones), ahora que el codigo fuente ya genera
// "VIKEN" a secas para los nuevos (ver text-utils.js / compilation.js).
//
// Reemplazo de texto simple ("VIKEN Home" -> "VIKEN"), sin tocar nada mas del titulo/descripcion.
//
// Uso:
//   node backfill-remove-home.mjs            (dry run, no escribe nada)
//   node backfill-remove-home.mjs --apply     (aplica los cambios en YouTube)
import 'dotenv/config';
import { google } from 'googleapis';
import { fetchAllChannelVideos } from './youtube-helpers.js';

const DRY_RUN = !process.argv.includes('--apply');

function buildYoutubeClient() {
  const oauth2Client = new google.auth.OAuth2(process.env.YT_CLIENT_ID, process.env.YT_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.YT_REFRESH_TOKEN });
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

async function main() {
  const youtube = buildYoutubeClient();
  const videos = await fetchAllChannelVideos(youtube);

  const toFix = videos.filter(
    (v) => v.snippet.title.includes('VIKEN Home') || v.snippet.description.includes('VIKEN Home')
  );

  console.log(`Videos con "VIKEN Home": ${toFix.length} de ${videos.length}${DRY_RUN ? ' (dry run, pasa --apply)' : ''}`);

  let updated = 0;
  for (const v of toFix) {
    const newTitle = v.snippet.title.replaceAll('VIKEN Home', 'VIKEN');
    const newDescription = v.snippet.description.replaceAll('VIKEN Home', 'VIKEN');

    console.log(`\n${v.id} (${v.status.privacyStatus})`);
    console.log(`  antes: ${v.snippet.title}`);
    console.log(`  ahora: ${newTitle}`);

    if (!DRY_RUN) {
      try {
        await youtube.videos.update({
          part: ['snippet'],
          requestBody: {
            id: v.id,
            snippet: { ...v.snippet, title: newTitle, description: newDescription },
          },
        });
        updated++;
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
      }
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}Actualizados: ${DRY_RUN ? toFix.length : updated}/${toFix.length}`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
