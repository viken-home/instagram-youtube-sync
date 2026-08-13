// Helpers compartidos para consultar el estado real del canal (usado por sync.js y por los
// scripts puntuales de backfill/programacion). Centralizado aca para que todos vean exactamente
// los mismos datos y el mismo criterio de "que es una recopilacion".

const PUBLISH_HOUR_ARG = 19; // 19:00 hora Argentina. Argentina no usa horario de verano (UTC-3 fijo).
const PUBLISH_HOUR_UTC = PUBLISH_HOUR_ARG + 3;

export function isCompilation(video) {
  // "VIKEN" (sin "Home") es substring de ambos formatos, viejo y nuevo -- asi el detector
  // sigue funcionando para las recopilaciones ya publicadas antes del cambio de texto.
  return video.snippet.description.includes('Una selección de piezas VIKEN');
}

export async function fetchAllChannelVideos(youtube) {
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

  // La paginacion de la playlist de subidos puede repetir un mismo video si se publica/sube algo
  // justo mientras se esta paginando (pasa seguido: este mismo script sube/publica Shorts al mismo
  // tiempo que corre esta consulta) -- confirmado: causo un mail de "4 Shorts publicados" que en
  // realidad eran el mismo video 4 veces. Se saca el duplicado ANTES de pedir los detalles, asi
  // ningun consumidor de fetchAllChannelVideos (mails, calculo de proximo horario) lo hereda.
  videoIds = [...new Set(videoIds)];

  let all = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    // contentDetails incluido para poder leer contentDetails.regionRestriction.blocked -- es la
    // unica forma (confirmada a mano) de detectar un bloqueo de Content ID via la Data API publica:
    // status.rejectionReason queda vacio para este tipo de bloqueo, no lo expone.
    const res = await youtube.videos.list({ part: ['snippet', 'status', 'contentDetails'], id: batch });
    all.push(...res.data.items);
  }
  return all;
}

// Proximo horario libre en la cola diaria de Shorts individuales (recopilaciones no cuentan:
// esas siguen manuales): el dia siguiente al ultimo que ya este programado, siempre a las 19:00
// hora Argentina. Si no hay ninguno en cola todavia, arranca manana.
export function computeNextSlotFromVideos(videos) {
  const queued = videos.filter(
    (v) => v.status.privacyStatus === 'private' && v.status.publishAt && !isCompilation(v)
  );

  const base = queued.length === 0
    ? new Date()
    : queued.reduce((max, v) => {
        const d = new Date(v.status.publishAt);
        return d > max ? d : max;
      }, new Date(0));

  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCHours(PUBLISH_HOUR_UTC, 0, 0, 0);
  return next;
}

export async function nextAvailableSlot(youtube) {
  const videos = await fetchAllChannelVideos(youtube);
  return computeNextSlotFromVideos(videos);
}
