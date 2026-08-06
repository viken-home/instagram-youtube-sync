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
