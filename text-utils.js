export const MAX_TITLE_LENGTH = 95;

export function sanitizeForYoutube(text) {
  // YouTube rechaza < y > en título/descripción (error "invalid video description").
  return text.replace(/>/g, '→').replace(/</g, '‹');
}

// Corta un título al límite de YouTube sin partir una palabra al medio (si hay
// un espacio razonablemente cerca del final).
export function truncateTitle(title, maxLength = MAX_TITLE_LENGTH) {
  if (title.length <= maxLength) return title;
  const cut = title.slice(0, maxLength - 3);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : cut.length)}...`;
}

export const BRAND_FOOTER = [
  'VIKEN 🏠 diseñamos y fabricamos nosotros mismos cada pieza de decoración — no es catálogo genérico, es taller propio, así que lo que ves acá no lo conseguís en otro lado.',
  '',
  '¿Querés armar tu rincón? Te asesoramos 1:1 por Instagram.',
  '',
  '📷 Instagram: https://www.instagram.com/vikenhome_',
  '🛒 Comprá acá: https://www.viken.com.ar',
].join('\n');

export const HASHTAGS = '#VikenHome #Decoracion #Hogar #Shorts';

export function buildDescription(caption, permalink) {
  const body = [caption, '', BRAND_FOOTER, '', `Post original: ${permalink}`, '', HASHTAGS]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
  return sanitizeForYoutube(body);
}
