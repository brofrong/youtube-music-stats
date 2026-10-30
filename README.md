# ytm-stats — YouTube Music статистика

Статичный сайт с топами исполнителей/треков, графиком по месяцам и календарем активности. Данные — только YouTube Music из Google Takeout.

Сайт: https://brofrong.github.io/youtube-music-stats/

## Архитектура

```
Google Takeout (на Диск, каждые 2 месяца) -> Google Drive -> GitHub Actions (ingest.yml, по понедельникам) -> scripts/fetch.ts -> takeout/ -> scripts/parse.ts -> site/data.json -> Pages
```

- `scripts/fetch.ts` — находит на Drive последний экспорт `takeout-*.zip` (включая многотомные `-001.zip`, `-002.zip`), качает части по очереди и достаёт из них только `watch-history.*`. Уже обработанный экспорт запоминается в `site/.last-takeout-id`, повторные запуски ничего не делают.
- `scripts/parse.ts` — парсит `watch-history.html` **и** `watch-history.json`, фильтрует только `YouTube Music`, чистит `Artist - Topic -> Artist`, инкрементально дедуплицирует по `video|ts`. Время хранится в UTC (часовой пояс из HTML пересчитывается). Если новые данные почти не совпадают со старыми за общий период, парсер отказывается писать (защита от задвоения истории), обход — `--force`.
- `site/index.html` — только музыка, в топе треков `Название — Исполнитель`, дни считаются в часовом поясе браузера.

## Локальная разработка

```bash
bun install
bun run parse              # парсит takeout/ -> site/data.json (инкрементально)
bun run parse -- --no-incremental  # перезаписать с нуля
bun test                   # тесты парсера
bun --hot index.ts         # dev server http://localhost:3000
```

## Настройка авто-обновления (вариант A: Drive)

### 1. Google Takeout на Диск

1. https://takeout.google.com -> **Создать экспорт**
2. Снять все галки, выбрать только `YouTube and YouTube Music`
3. В `All YouTube data included` оставить только **history** (иначе в архив попадут видео, и он разобьётся на много частей по 2 ГБ)
4. **Способ получения: Добавить на Диск**, частота **Каждые 2 месяца в течение 1 года**, тип `.zip`
5. Создать экспорт. Теперь каждые 2 месяца на Диске (папка `Takeout`) появится `takeout-*.zip`. Старые экспорты можно удалять — нужен только последний.

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
- `DRIVE_FOLDER_ID` (опционально) — ID папки из URL `https://drive.google.com/drive/folders/<ID>`. Если в ней ничего не найдено, поиск идёт по всему Диску (с warning в логе).

### 5. Проверка

- Actions -> `Ingest Takeout` -> **Run workflow** (можно передать `takeout_url` вручную для теста, или `force`, чтобы заново обработать последний экспорт).
- По расписанию: `cron: 0 6 * * 1` (каждый понедельник). Пока нового экспорта нет, запуск просто завершается.
- Workflow качает экспорт, парсит инкрементально, коммитит `site/data.json` + `site/.last-takeout-id` и деплоит Pages (только если что-то изменилось).

Локальный тест без Drive:

```bash
TAKEOUT_URL=https://storage.googleapis.com/... bun run scripts/fetch.ts
# или просто положить Takeout.zip в корень
bun run scripts/parse.ts --input Takeout.zip
```

## Ручной триггер с прямой ссылкой

Если не хочешь OAuth, можешь запускать workflow вручную с `takeout_url`: скопируй ссылку из письма Takeout (pre-signed, живет 7 дней) и вставь в `Run workflow -> takeout_url`.

## Миграция старых данных

Старый `site/data.json` с полями `{channel, m}` уже мигрирован в `{title, artist, date, ts, video}` (время в UTC) с чисткой ` - Topic` и фильтром только музыки:

```bash
bun run scripts/migrate.ts
```
