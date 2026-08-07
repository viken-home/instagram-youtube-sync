// Helpers compartidos para consultar el estado real del canal (usado por sync.js y por los
// scripts puntuales de backfill/programacion). Centralizado aca para que todos vean exactamente
// los mismos datos y el mismo criterio de "que es una recopilacion".

const PUBLISH_HOUR_ARG = 19; // 19:00 hora Argentina. Argentina no usa horario de verano (UTC-3 fijo).
const PUBLISH_HOUR_UTC = PUBLISH_HOUR_ARG + 3;

export function isCompilation(video) {
  return video.snippet.description.includes('Una selección de piezas VIKEN Home');
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

  let all = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const res = await youtube.videos.list({ part: ['snippet', 'status'], id: batch });
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
