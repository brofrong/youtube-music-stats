# ytm-stats

Личная статистика прослушиваний YouTube Music: топ-100 исполнителей и треков,
счётчики и фильтры по периодам (всё время / год / месяц / 30 дней / свой диапазон).

Данные берутся из Google Takeout (`YouTube and YouTube Music → history → watch-history.html`),
парсятся скриптом `parse_takeout.py` в `site/data.json`, сайт деплоится на GitHub Pages.

## Обновление данных

1. Скачай новый Takeout (takeout.google.com → My Activity → YouTube)
2. Распакуй в `takeout/`
3. Запусти `python3 parse_takeout.py`
4. Закоммить обновлённый `site/data.json` — Actions задеплоит сам

Сайт: https://brofrong.github.io/ytm-stats/
