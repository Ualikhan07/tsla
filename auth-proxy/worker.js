/**
 * Cloudflare Worker: Google OAuth Device Flow Token Proxy
 * 
 * Позволяет безопасно обменивать device_code и refresh_token на access_token Google OAuth,
 * храня GOOGLE_CLIENT_SECRET на стороне сервера (в переменных окружения Cloudflare Worker),
 * исключая утечку секрета в публичный клиентский код или репозиторий GitHub.
 *
 * Переменные окружения (Cloudflare Dashboard -> Settings -> Variables):
 * - GOOGLE_CLIENT_SECRET: Секретный ключ Google OAuth (Secret)
 * - GOOGLE_CLIENT_ID (опционально): Если хотите задать Client ID по умолчанию
 */

export default {
  async fetch(request, env) {
    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Разрешен только POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'Only POST supported' }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    try {
      const body = await request.json();
      const clientId = env.GOOGLE_CLIENT_ID || body.client_id;
      const clientSecret = env.GOOGLE_CLIENT_SECRET;

      if (!clientSecret) {
        return new Response(JSON.stringify({
          error: 'server_configuration_error',
          message: 'GOOGLE_CLIENT_SECRET is not configured in worker environment variables.'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: body.grant_type,
      });

      if (body.device_code) {
        params.append('device_code', body.device_code);
      }
      if (body.refresh_token) {
        params.append('refresh_token', body.refresh_token);
      }

      // Отправляем авторизованный запрос в Google OAuth
      const googleRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });

      const data = await googleRes.text();

      return new Response(data, {
        status: googleRes.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'proxy_internal_error', message: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
  },
};
