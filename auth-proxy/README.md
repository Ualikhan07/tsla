# 🛡 Безопасный OAuth Прокси для Tesla Cinema (Google Device Flow)

Этот воркер решает проблему утечки `GOOGLE_CLIENT_SECRET`: секретный ключ Google хранится **только на сервере** в Cloudflare Workers, а клиентский код (GitHub Pages) не содержит секретов.

---

### Быстрый деплой за 1 минуту (Бесплатно)

1. Зайдите на [dash.cloudflare.com](https://dash.cloudflare.com/) (бесплатный аккаунт).
2. Перейдите в раздел **Workers & Pages** -> **Create application** -> **Create Worker**.
3. Вставьте содержимое файла `worker.js` в онлайн-редактор Cloudflare и нажмите **Deploy**.
4. Перейдите в **Settings** воркера -> **Variables and Secrets**:
   - Нажмите **Add variable / Add secret**:
     - Имя: `GOOGLE_CLIENT_SECRET`
     - Значение: ваш новый секрет из Google Cloud Console (тип: *Secret* / зашифровано).
     - (Опционально) `GOOGLE_CLIENT_ID`: ваш Client ID.
5. Скопируйте URL вашего воркера (например: `https://tesla-oauth-proxy.username.workers.dev`).

---

### Подключение к Tesla Cinema

В браузере (или в консоли разработчика / настройках сайта) выполните одну команду:

```javascript
localStorage.setItem('google_auth_proxy', 'https://tesla-oauth-proxy.username.workers.dev');
```

После этого все обмены токенов (вход по QR и фоновое обновление) будут идти через защищенный прокси, без передачи секрета с клиента!

---

### Вариант без прокси (локальное хранилище)

Если вы не хотите запускать серверный воркер, вы можете просто сохранить новый сгенерированный секрет локально в браузере:

```javascript
localStorage.setItem('google_client_secret', 'ВАШ_НОВЫЙ_СЕКРЕТ');
```

В этом случае секрет хранится только в вашем личном браузере и никогда не попадет в публичный GitHub репозиторий.
