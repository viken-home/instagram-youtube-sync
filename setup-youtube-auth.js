import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';

const PORT = 8080;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const { YT_CLIENT_ID, YT_CLIENT_SECRET } = process.env;

if (!YT_CLIENT_ID || !YT_CLIENT_SECRET) {
  console.error('Falta YT_CLIENT_ID y/o YT_CLIENT_SECRET en .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/youtube.upload'],
});

console.log('\nAbrí esta URL en el navegador logueado con la cuenta de Google de VIKEN:\n');
console.log(authUrl);
console.log(`\nEsperando el callback en ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth2callback')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Error de autorización: ${error}. Podés cerrar esta pestaña.`);
    console.error(`Error de autorización: ${error}`);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Listo, ya podés cerrar esta pestaña y volver a la terminal.');

    console.log('Autorización exitosa.\n');
    console.log('Agregá esto a tu .env:\n');
    console.log(`YT_REFRESH_TOKEN=${tokens.refresh_token}\n`);

    if (!tokens.refresh_token) {
      console.warn(
        'Atención: Google no devolvió un refresh_token. Esto pasa si ya habías autorizado esta app antes.\n' +
          'Solución: andá a https://myaccount.google.com/permissions, revocá el acceso de esta app, y volvé a correr este script.'
      );
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Error al intercambiar el código. Revisá la terminal.');
    console.error('Error al obtener tokens:', err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
