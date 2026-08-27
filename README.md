# ytm-stats — YouTube Music статистика

Статичный сайт с топами исполнителей/треков, графиком по месяцам и календарем активности. Данные — только YouTube Music из Google Takeout.

Сайт: https://brofrong.github.io/youtube-music-stats/

## Архитектура

```
Google Takeout (на Диск, каждые 2 месяца) -> Google Drive -> GitHub Actions (ingest.yml) -> scripts/fetch.ts -> Takeout.zip -> scripts/parse.ts -> site/data.json -> Pages
```

- `scripts/parse.ts` — парсит `watch-history.html` **и** `watch-history.json`, фильтрует только `YouTube Music`, чистит `Artist - Topic -> Artist`, инкрементально дедуплицирует по `video|ts`.
- `scripts/fetch.ts` — качает последний `takeout*.zip` с Drive по `drive.readonly`.
- `site/index.html` — только музыка, в топе треков `Название — Исполнитель`.

## Локальная разработка

```bash
bun install
bun run parse              # парсит takeout/ -> site/data.json (инкрементально)
bun run parse -- --no-incremental  # перезаписать с нуля
bun --hot index.ts         # dev server http://localhost:3000
```

## Настройка авто-обновления (вариант A: Drive)

### 1. Google Takeout на Диск

1. https://takeout.google.com -> **Создать экспорт**
2. Снять все галки, выбрать только `YouTube and YouTube Music`
3. **Способ получения: Добавить на Диск**, частота **Каждые 2 месяца в течение 1 года**, тип `.zip`, размер `2 ГБ`
4. Создать экспорт. Теперь каждые 2 месяца на Диске появится `takeout-*.zip`.

### 2. Google Cloud OAuth

1. https://console.cloud.google.com -> создать проект (или выбрать существующий)
2. **APIs & Services -> Enabled APIs -> Enable Google Drive API**
3. **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**
   - Type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/callback`
4. Сохрани `Client ID` и `Client Secret`
5. **APIs & Services -> OAuth consent screen** -> External -> Fill app name, add scope `drive.readonly` if asked, add себя в Test users (пока app в Testing).

### 3. Получить Refresh Token

```bash
GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy bun run scripts/get-token.ts
# открой ссылку, авторизуйся, в терминале появится GOOGLE_REFRESH_TOKEN
```

Или вручную: `https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=http://localhost:3000/callback&response_type=code&scope=https://www.googleapis.com/auth/drive.readonly&access_type=offline&prompt=consent`

### 4. GitHub Secrets

Repo -> Settings -> Secrets and variables -> Actions -> New secret:

- `GOOGLE_CLIENT_ID` — из шага 2
- `GOOGLE_CLIENT_SECRET` — из шага 2
- `GOOGLE_REFRESH_TOKEN` — из шага 3
- `DRIVE_FOLDER_ID` (опционально) — если Takeout падает в папку, возьми ID из URL `https://drive.google.com/drive/folders/<ID>`

### 5. Проверка

- Actions -> `Ingest Takeout` -> **Run workflow** (можно передать `takeout_url` вручную для теста).
- По расписанию: `cron: 0 6 1 * *` (1-го числа каждого месяца).
- Workflow качает zip, парсит инкрементально, коммитит `site/data.json` и деплоит Pages.

Локальный тест без Drive:

```bash
TAKEOUT_URL=https://storage.googleapis.com/... bun run scripts/fetch.ts
# или просто положить Takeout.zip в корень
bun run scripts/parse.ts --input Takeout.zip
```

## Ручной триггер с прямой ссылкой

Если не хочешь OAuth, можешь запускать workflow вручную с `takeout_url`: скопируй ссылку из письма Takeout (pre-signed, живет 7 дней) и вставь в `Run workflow -> takeout_url`.

## Миграция старых данных

Старый `site/data.json` с полями `{channel, m}` уже мигрирован в `{title, artist, date, ts, video, token}` с чисткой ` - Topic` и фильтром только музыки:

```bash
bun run scripts/migrate.ts
```
