# Tesla Cinema D/R Stream Proxy Backend

Этот сервер предназначен для обхода блокировок видео в Tesla в движении (режимы Drive и Reverse) и полного отключения рекламы YouTube.

## Как запустить бесплатно за 2 минуты:

### Вариант 1: Render.com (Бесплатно)
1. Зарегистрируйтесь на [render.com](https://render.com).
2. Нажмите **New +** -> **Web Service**.
3. Выберите репозиторий GitHub (`tsla`).
4. В Root Directory укажите: `backend`.
5. Environment: `Docker` (Render автоматически соберет наш Dockerfile с `yt-dlp` и `ffmpeg`).
6. После деплоя скопируйте выданный URL (например: `https://tesla-cinema-backend.onrender.com`).
7. В интерфейсе Tesla Cinema нажмите на кнопку **«🚀 Свой Сервер»** и вставьте этот URL!

### Вариант 2: Railway.app (Бесплатно)
1. Зарегистрируйтесь на [railway.app](https://railway.app).
2. Нажмите **New Project** -> **Deploy from GitHub repo** -> выберите репозиторий.
3. В настройках сервиса укажите Root Directory: `/backend`.
4. Сгенерируйте публичный домен в разделе Settings -> Networking.
5. Вставьте домен в Tesla Cinema!

### Вариант 3: Локально на Mac / Linux
```bash
cd backend
npm install
node server.js
```
