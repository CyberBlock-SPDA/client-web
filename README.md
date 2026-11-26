# CyberBlock — client-web

Frontend веб-клиента платформы облачного гейминга CyberBlock.

Клиент позволяет выбирать игры, создавать игровые сессии и подключаться к игровому серверу через WebSocket и WebRTC.

## Технологии

- TypeScript
- Vite
- HTML / CSS
- WebSocket
- WebRTC

## Возможности

- Каталог игр.
- Создание игровой сессии через backend API.
- Подключение к signaling-серверу.
- Получение игрового видеопотока.
- Передача управления через клавиатуру и мышь.
- Обработка ошибок соединения и таймаутов.
- Завершение сессии и очистка соединений.

## Структура проекта

```text
client-web/
├── web/
│   ├── src/
│   │   └── main.ts
│   ├── index.html
│   └── style.css
├── Dockerfile
├── nginx.conf
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── .dockerignore
└── .gitignore
```

Основная логика приложения находится в `web/src/main.ts`, разметка — в `web/index.html`, стили — в `web/style.css`.

## Запуск

Требуется Node.js 20+ и npm.

Установить зависимости:

```bash
npm install
```

Запустить локальный сервер:

```bash
npm run dev
```

Открыть `http://localhost:5173`.

## Конфигурация

Параметры клиента задаются через `window.CYBERBLOCK_CONFIG` в `web/index.html`.

Основные настройки:
- `apiBaseUrl` — адрес backend.
- `iceServers` — STUN/TURN серверы.
- `requestTimeoutMs` — таймаут REST-запросов.
- `signalingTimeoutMs` — таймаут signaling.
- `connectionTimeoutMs` — таймаут WebRTC.
- `disconnectGraceMs` — время ожидания восстановления соединения.

## Сборка

```bash
npm run build
```

Для локального просмотра production-сборки:

```bash
npm run preview
```

Результат сборки находится в `dist/`.

## Интеграция

Для создания игровой сессии клиент отправляет `POST /api/v1/sessions` с идентификатором игры. Для DOOM используется `doom-1993`.

После получения параметров сессии клиент подключается к signaling-серверу через WebSocket, устанавливает WebRTC-соединение и получает видеопоток. Управление передаётся через DataChannel `game-input`.

Для полноценной работы необходимы запущенные backend и game-streamer. Успешная сборка frontend сама по себе не подтверждает работу всей системы.