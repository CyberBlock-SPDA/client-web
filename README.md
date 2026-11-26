# CyberBlock — client-web

Браузерный клиент платформы облачного гейминга CyberBlock.

Клиент реализован на TypeScript с использованием Vite, WebSocket и WebRTC.
Он отвечает за пользовательский интерфейс, создание игровой сессии через
backend, signaling, получение видеопотока и передачу пользовательского ввода.

## Возможности

- Каталог игр и переход к игровой сессии.
- Проверка поддержки WebRTC, WebSocket и необходимых браузерных API.
- Проверка доступности backend.
- Создание игровой сессии через REST API.
- Обработка HTTP-ошибок, таймаутов и сетевых сбоев.
- WebSocket signaling и обмен SDP.
- Обмен ICE candidates с буферизацией до установки remote description.
- Установка WebRTC-соединения и получение видеопотока.
- Передача клавиатуры и мыши через DataChannel.
- Относительное движение мыши и Pointer Lock на стороне браузера.
- Обработка потери фокуса и освобождение нажатых клавиш и кнопок.
- Завершение сессии и очистка клиентских ресурсов.

## Технологии

- TypeScript
- Vite
- WebSocket
- WebRTC
- RTCPeerConnection
- RTCDataChannel
- HTML5 и CSS
- Nginx и Docker

## Структура проекта

```text
client-web/
├── web/
│   ├── src/
│   │   └── main.ts
│   ├── index.html
│   └── style.css
├── .dockerignore
├── .gitignore
├── Dockerfile
├── nginx.conf
├── package.json
├── package-lock.json
├── tsconfig.json
└── vite.config.ts
```

Основная логика приложения находится в `web/src/main.ts`.

## Требования

- Node.js 20 или новее.
- npm.
- Современный браузер с поддержкой WebRTC и WebSocket.

## Установка и запуск

Установить зависимости:

```bash
npm ci
```

Запустить dev-сервер:

```bash
npm run dev
```

По умолчанию Vite использует адрес:

```text
http://localhost:5173
```

## Конфигурация

Параметры клиента задаются через `window.CYBERBLOCK_CONFIG`
в `web/index.html`.

Основные параметры:

```javascript
    window.CYBERBLOCK_CONFIG = {
        apiBaseUrl: `${window.location.protocol}//${window.location.hostname}:8080`,
        iceServers: [],
        requestTimeoutMs: 10000,
        signalingTimeoutMs: 15000,
        connectionTimeoutMs: 20000,
        disconnectGraceMs: 7000
    };
```

`apiBaseUrl` должен указывать на адрес backend, доступный из браузера.
Для работы с другого устройства нельзя указывать `localhost`, если backend
не запущен на самом этом устройстве.

При размещении frontend и backend на разных origin необходимо настроить CORS.
При использовании HTTPS signaling должен работать через WSS.

## Архитектура игровой сессии

1. Пользователь выбирает DOOM.
2. Клиент проверяет поддержку браузерных технологий.
3. Клиент проверяет доступность backend.
4. Клиент отправляет `POST /api/v1/sessions`.
5. Backend выделяет игровой сервер и возвращает параметры сессии.
6. Браузер подключается к Game Agent через WebSocket.
7. Клиент отправляет сообщение `authenticate`.
8. Происходит обмен SDP Offer/Answer и ICE candidates.
9. Устанавливается прямое WebRTC-соединение с игровым сервером.
10. Браузер получает видеопоток и передаёт ввод через DataChannel.
11. При выходе клиент закрывает локальные соединения и освобождает ресурсы.

Backend отвечает за выделение и жизненный цикл игрового сервера.
Frontend не обращается напрямую к Kubernetes или Agones.

## API и протоколы

REST endpoint:

```http
POST /api/v1/sessions
Content-Type: application/json
```

Для DOOM используется идентификатор:

```json
{
  "gameId": "doom-1993"
}
```

Клиент ожидает успешный HTTP-ответ `201` с идентификатором сессии,
параметрами signaling и WebRTC, а также временным `sessionToken`.

Для signaling используется WebSocket. Первым прикладным сообщением
отправляется `authenticate`.

DataChannel называется `game-input`. Он использует ненадёжную
неупорядоченную передачу данных и сообщения протокола ввода,
определённые в API-контракте CyberBlock.

Pointer Lock применяется браузером для получения относительных
перемещений мыши. Отдельное сообщение Pointer Lock в DataChannel
не отправляется.

## Сеть

- Backend должен быть доступен браузеру.
- При разных origin требуется корректная настройка CORS.
- Для HTTPS требуется WSS.
- WebRTC использует ICE candidates для установления медиасоединения.
- Для работы через NAT и разные сети может потребоваться STUN/TURN.

Номер UDP-порта из REST-ответа сам по себе не гарантирует доступность
медиасоединения: Game Agent должен корректно передавать ICE candidates.

## Сборка

Проверка TypeScript и production-сборка:

```bash
npm run build
```

Результат сборки находится в `dist/`.

Локальный просмотр production-сборки:

```bash
npm run preview
```

## Docker

Сборка образа из корня репозитория `client-web`:

```bash
docker build -t cyberblock-client .
```

Запуск:

```bash
docker run --rm -p 8081:80 cyberblock-client
```

Frontend будет доступен по адресу:

```text
http://localhost:8081
```

Nginx предоставляет `/healthz` и `/readyz` для проверки HTTP-сервера
frontend. Эти проверки не подтверждают доступность backend или Game Agent.

## Ограничения и статус интеграции

Production-сборка подтверждает компиляцию frontend, но не подтверждает
успешное подключение к реальному игровому серверу.

Для подтверждения полного сценария необходимо интеграционное тестирование
с работающими backend и game-streamer: выделение сессии, signaling,
WebRTC-видеопоток, ввод с клавиатуры и мыши, потеря соединения,
завершение сессии и повторный запуск.
