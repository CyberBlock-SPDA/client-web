type AppState =
    | "IDLE"
    | "ALLOCATING"
    | "SIGNALING"
    | "CONNECTING"
    | "PLAYING"
    | "CLEANUP"
    | "ERROR";

interface SessionInfo {
    sessionId: string;
    gameId: string;
    server: {
        host: string;
        signaling: {
            protocol: "ws" | "wss";
            port: number;
            path: string;
        };
        webrtc: {
            protocol: "udp";
            port: number;
        };
    };
    sessionToken: string;
    tokenExpiresAt: string;
    expiresAt: string;
}

interface ClientConfig {
    apiBaseUrl?: string;
    iceServers?: RTCIceServer[];
    requestTimeoutMs?: number;
    signalingTimeoutMs?: number;
    connectionTimeoutMs?: number;
    disconnectGraceMs?: number;
}

declare global {
    interface Window {
        CYBERBLOCK_CONFIG?: ClientConfig;
    }
}

const config = window.CYBERBLOCK_CONFIG ?? {};

const API_URL = (config.apiBaseUrl ?? "http://localhost:8080")
    .replace(/\/+$/, "");

const REQUEST_TIMEOUT = config.requestTimeoutMs ?? 10000;
const SIGNALING_TIMEOUT = config.signalingTimeoutMs ?? 15000;
const CONNECTION_TIMEOUT = config.connectionTimeoutMs ?? 20000;
const DISCONNECT_GRACE = config.disconnectGraceMs ?? 7000;

let state: AppState = "IDLE";
let currentSession: SessionInfo | null = null;
let peer: RTCPeerConnection | null = null;
let socket: WebSocket | null = null;
let inputChannel: RTCDataChannel | null = null;
let inputController: InputController | null = null;
let requestController: AbortController | null = null;

let disconnectTimer: number | null = null;
let connectionTimer: number | null = null;

let localIceComplete = false;
let remoteIceComplete = false;
let remoteDescriptionSet = false;
let connectionEstablished = false;
let signalingAuthenticated = false;
let signalingClosedIntentionally = false;
let starting = false;
let cleaning = false;
let runId = 0;

let pendingCandidates: RTCIceCandidateInit[] = [];
let renderedRoute = "";

const $ = <T extends HTMLElement>(id: string): T | null =>
    document.getElementById(id) as T | null;

function setText(id: string, value: string): void {
    const el = $(id);
    if (el) el.textContent = value;
}

function show(id: string): void {
    $(id)?.classList.remove("hidden");
}

function hide(id: string): void {
    $(id)?.classList.add("hidden");
}

function setState(next: AppState): void {
    state = next;

    const labels: Record<AppState, string> = {
        IDLE: "ГОТОВ К ЗАПУСКУ",
        ALLOCATING: "ПОИСК ИГРОВОГО СЕРВЕРА",
        SIGNALING: "УСТАНОВКА СОЕДИНЕНИЯ",
        CONNECTING: "ПОДКЛЮЧЕНИЕ К ИГРЕ",
        PLAYING: "ИГРА ЗАПУЩЕНА",
        CLEANUP: "ЗАВЕРШЕНИЕ СЕССИИ",
        ERROR: "ОШИБКА"
    };

    setText("connection-label", `СТАТУС: ${labels[next]}`);

    const busy = [
        "ALLOCATING",
        "SIGNALING",
        "CONNECTING",
        "PLAYING",
        "CLEANUP"
    ].includes(next);

    document.querySelectorAll<HTMLButtonElement>(
        "[data-play-game], #details-play"
    ).forEach(button => {
        button.disabled = busy;
    });

    if (next === "PLAYING") {
        setText("game-message", "Игра запущена");
        hide("game-loader");
        hide("game-placeholder");
    }
}

function withTimeout<T>(
    promise: Promise<T>,
    timeout: number,
    message: string
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(
            () => reject(new Error(message)),
            timeout
        );

        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

// ---------- BROWSER ----------

function checkBrowser(): void {
    if (!("RTCPeerConnection" in window)) {
        throw new Error("Браузер не поддерживает WebRTC.");
    }

    if (!("WebSocket" in window)) {
        throw new Error("Браузер не поддерживает WebSocket.");
    }

    if (!("fetch" in window) || !("AbortController" in window)) {
        throw new Error("Браузер не поддерживает необходимые API.");
    }
}

async function checkBackend(): Promise<void> {
    const controller = new AbortController();
    requestController = controller;

    const timer = window.setTimeout(
        () => controller.abort(),
        4000
    );

    try {
        const response = await fetch(`${API_URL}/healthz`, {
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Backend вернул HTTP ${response.status}`);
        }
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error("Проверка backend отменена или превышено время ожидания.");
        }

        throw new Error(
            `Backend недоступен: ${
                error instanceof Error ? error.message : "ошибка сети"
            }`
        );
    } finally {
        clearTimeout(timer);

        if (requestController === controller) {
            requestController = null;
        }
    }
}

// ---------- REST ----------

async function createSession(gameId: string): Promise<SessionInfo> {
    const controller = new AbortController();
    requestController = controller;

    const timer = window.setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT
    );

    try {
        const response = await fetch(`${API_URL}/api/v1/sessions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, application/problem+json"
            },
            body: JSON.stringify({
                gameId: gameId === "doom" ? "doom-1993" : gameId
            }),
            signal: controller.signal
        });

        const body = await response.json().catch(() => ({}));

        if (response.status === 503) {
            const retry = response.headers.get("Retry-After");

            throw new Error(
                "Нет свободных игровых серверов." +
                (retry ? ` Повторите попытку через ${retry} сек.` : "")
            );
        }

        if (!response.ok) {
            throw new Error(
                body.detail ||
                body.title ||
                `Ошибка backend: HTTP ${response.status}`
            );
        }

        if (response.status !== 201) {
            throw new Error("Backend должен вернуть HTTP 201.");
        }

        const session = body as SessionInfo;

        const signaling = session.server?.signaling;
        const webrtc = session.server?.webrtc;

        if (
            typeof session.sessionId !== "string" ||
            !session.sessionId ||
            session.gameId !== "doom-1993" ||
            typeof session.server?.host !== "string" ||
            !session.server.host ||
            typeof signaling?.protocol !== "string" ||
            typeof signaling?.port !== "number" ||
            typeof signaling?.path !== "string" ||
            typeof webrtc?.protocol !== "string" ||
            typeof webrtc?.port !== "number" ||
            typeof session.sessionToken !== "string" ||
            !session.sessionToken ||
            typeof session.tokenExpiresAt !== "string" ||
            typeof session.expiresAt !== "string"
        ) {
            throw new Error("Backend вернул неполные параметры сессии.");
        }

        if (
            !["ws", "wss"].includes(signaling.protocol) ||
            signaling.path !== "/ws" ||
            !Number.isInteger(signaling.port) ||
            signaling.port < 1 ||
            signaling.port > 65535
        ) {
            throw new Error("Некорректные параметры signaling.");
        }

        if (
            webrtc.protocol !== "udp" ||
            !Number.isInteger(webrtc.port) ||
            webrtc.port < 1 ||
            webrtc.port > 65535
        ) {
            throw new Error("Некорректные параметры WebRTC.");
        }

        if (
            !Number.isFinite(Date.parse(session.tokenExpiresAt)) ||
            !Number.isFinite(Date.parse(session.expiresAt))
        ) {
            throw new Error("Backend вернул некорректное время действия сессии.");
        }

        return session;
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(
                "Запрос отменён или превышено время ожидания. " +
                "Результат создания сессии может быть неизвестен."
            );
        }

        throw error;
    } finally {
        clearTimeout(timer);

        if (requestController === controller) {
            requestController = null;
        }
    }
}

// ---------- SIGNALING ----------

function signalingURL(session: SessionInfo): string {
    const protocol = location.protocol === "https:"
        ? "wss:"
        : session.server.signaling.protocol === "wss"
            ? "wss:"
            : "ws:";

    return `${protocol}//${session.server.host}:` +
        `${session.server.signaling.port}` +
        session.server.signaling.path;
}

function sendSignal(message: object): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket signaling недоступен.");
    }

    socket.send(JSON.stringify(message));
}

function waitForSocketOpen(ws: WebSocket): Promise<void> {
    return withTimeout(
        new Promise((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });

            ws.addEventListener("error", () => {
                reject(new Error("Ошибка WebSocket."));
            }, { once: true });

            ws.addEventListener("close", () => {
                reject(new Error("WebSocket закрыт до подключения."));
            }, { once: true });
        }),
        SIGNALING_TIMEOUT,
        "Таймаут подключения WebSocket."
    );
}

async function handleAnswer(message: {
    type: string;
    sdp: string;
}): Promise<void> {
    if (!peer || !message.sdp) {
        throw new Error("Некорректный SDP Answer.");
    }

    await peer.setRemoteDescription({
        type: "answer",
        sdp: message.sdp
    });

    remoteDescriptionSet = true;

    for (const candidate of pendingCandidates) {
        await peer.addIceCandidate(candidate);
    }

    pendingCandidates = [];

    if (remoteIceComplete) {
        await peer.addIceCandidate(null);
    }
}

async function handleRemoteCandidate(
    candidate: RTCIceCandidateInit
): Promise<void> {
    if (!candidate || !candidate.candidate) return;

    if (!peer || !remoteDescriptionSet) {
        pendingCandidates.push(candidate);
        return;
    }

    await peer.addIceCandidate(candidate);
}

function handleSignalingMessage(
    message: Record<string, unknown>,
    session: SessionInfo,
    resolveAuth: () => void
): void {
    const type = message.type;

    if (type === "authenticated") {
        if (message.sessionId !== session.sessionId) {
            throw new Error("Session ID не совпадает.");
        }

        signalingAuthenticated = true;
        resolveAuth();
        return;
    }

    if (type === "error") {
        throw new Error(
            String(message.message ?? message.code ?? "Ошибка Game Agent.")
        );
    }

    if (type === "answer") {
        void handleAnswer({
            type: "answer",
            sdp: String(message.sdp ?? "")
        }).catch(error => failSession(String(error)));

        return;
    }

    if (type === "ice-candidate") {
        void handleRemoteCandidate(
            message.candidate as RTCIceCandidateInit
        ).catch(error => failSession(String(error)));

        return;
    }

    if (type === "ice-complete") {
        remoteIceComplete = true;

        if (remoteDescriptionSet) {
            void peer?.addIceCandidate(null).catch(
                error => failSession(String(error))
            );
        }

        maybeCloseSignaling();
    }
}

function maybeCloseSignaling(): void {
    if (
        localIceComplete &&
        remoteIceComplete &&
        connectionEstablished &&
        socket?.readyState === WebSocket.OPEN
    ) {
        signalingClosedIntentionally = true;
        socket.close(1000, "Signaling complete");
        socket = null;
    }
}

// ---------- INPUT ----------

class InputController {
    private keys = new Set<string>();
    private buttons = new Set<string>();
    private sequence = 0;
    private focused = true;
    private timer: number;

    constructor(
        private channel: RTCDataChannel,
        private surface: HTMLElement
    ) {
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onKeyUp = this.onKeyUp.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);
        this.onBlur = this.onBlur.bind(this);
        this.onWindowFocus = this.onWindowFocus.bind(this);
        this.onVisibility = this.onVisibility.bind(this);
        this.onSurfaceFocus = this.onSurfaceFocus.bind(this);
        this.onSurfaceClick = this.onSurfaceClick.bind(this);
        this.onContextMenu = this.onContextMenu.bind(this);
        this.onPointerLockChange = this.onPointerLockChange.bind(this);

        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("blur", this.onBlur);
        window.addEventListener("focus", this.onWindowFocus);
        window.addEventListener("mouseup", this.onMouseUp);

        document.addEventListener(
            "visibilitychange",
            this.onVisibility
        );

        document.addEventListener(
            "pointerlockchange",
            this.onPointerLockChange
        );

        surface.addEventListener("focus", this.onSurfaceFocus);
        surface.addEventListener("click", this.onSurfaceClick);
        surface.addEventListener("mousemove", this.onMouseMove);
        surface.addEventListener("mousedown", this.onMouseDown);
        surface.addEventListener("contextmenu", this.onContextMenu);

        this.timer = window.setInterval(
            () => this.sendSnapshot(),
            150
        );

        this.send({
            type: "focus",
            focused: true
        });

        this.sendSnapshot();
    }

    private send(message: object): void {
        if (this.channel.readyState !== "open") return;

        try {
            this.channel.send(JSON.stringify({
                ...message,
                seq: this.sequence++
            }));
        } catch {
            this.releaseLocal();
        }
    }

    private onKeyDown(event: KeyboardEvent): void {
        if (
            !this.focused ||
            event.repeat ||
            document.activeElement !== this.surface
        ) return;

        if (!this.keys.has(event.code)) {
            this.keys.add(event.code);

            this.send({
                type: "key",
                action: "down",
                code: event.code
            });
        }

        event.preventDefault();
    }

    private onKeyUp(event: KeyboardEvent): void {
        if (!this.keys.has(event.code)) return;

        this.keys.delete(event.code);

        this.send({
            type: "key",
            action: "up",
            code: event.code
        });

        event.preventDefault();
    }

    private onMouseMove(event: MouseEvent): void {
        if (
            !this.focused ||
            document.activeElement !== this.surface
        ) return;

        const dx = Math.max(
            -1000,
            Math.min(1000, Math.trunc(event.movementX))
        );

        const dy = Math.max(
            -1000,
            Math.min(1000, Math.trunc(event.movementY))
        );

        if (dx === 0 && dy === 0) return;

        this.send({
            type: "mouse_move",
            dx,
            dy
        });
    }

    private getButton(button: number): string | null {
        return ({
            0: "left",
            1: "middle",
            2: "right"
        } as Record<number, string>)[button] ?? null;
    }

    private onMouseDown(event: MouseEvent): void {
        const button = this.getButton(event.button);

        if (!button || !this.focused) return;

        this.surface.focus();

        if (!this.buttons.has(button)) {
            this.buttons.add(button);

            this.send({
                type: "mouse_button",
                button,
                action: "down"
            });
        }

        event.preventDefault();
    }

    private onMouseUp(event: MouseEvent): void {
        const button = this.getButton(event.button);

        if (!button || !this.buttons.has(button)) return;

        this.buttons.delete(button);

        this.send({
            type: "mouse_button",
            button,
            action: "up"
        });

        event.preventDefault();
    }

    private onSurfaceFocus(): void {
        this.setFocus(true);
    }

    private onSurfaceClick(): void {
        this.surface.focus();

        if (
            document.pointerLockElement !== this.surface &&
            typeof this.surface.requestPointerLock === "function"
        ) {
            try {
                const result = this.surface.requestPointerLock();

                if (result instanceof Promise) {
                    void result.catch(() => {
                        // Pointer Lock может быть запрещён браузером.
                    });
                }
            } catch {
                // Игра продолжит работать без Pointer Lock.
            }
        }
    }

    private onPointerLockChange(): void {
        if (document.pointerLockElement === this.surface) {
            this.setFocus(true);
        } else if (this.focused) {
            this.setFocus(false);
        }
    }

    private onContextMenu(event: MouseEvent): void {
        event.preventDefault();
    }

    private onBlur(): void {
        this.setFocus(false);
    }

    private onWindowFocus(): void {
        if (!document.hidden) {
            this.setFocus(true);
        }
    }

    private onVisibility(): void {
        if (document.hidden) {
            this.setFocus(false);
        }
    }

    private setFocus(value: boolean): void {
        if (this.focused === value) return;

        this.focused = value;

        this.send({
            type: "focus",
            focused: value
        });

        if (!value) {
            this.send({ type: "input_reset" });
            this.releaseLocal();
        }

        this.sendSnapshot();
    }

    private sendSnapshot(): void {
        this.send({
            type: "input_state",
            pressedKeys: [...this.keys],
            pressedButtons: [...this.buttons],
            focused: this.focused
        });
    }

    private releaseLocal(): void {
        this.keys.clear();
        this.buttons.clear();
    }

    destroy(): void {
        this.send({ type: "input_reset" });
        this.releaseLocal();

        clearInterval(this.timer);

        window.removeEventListener("keydown", this.onKeyDown);
        window.removeEventListener("keyup", this.onKeyUp);
        window.removeEventListener("blur", this.onBlur);
        window.removeEventListener("focus", this.onWindowFocus);
        window.removeEventListener("mouseup", this.onMouseUp);

        document.removeEventListener(
            "visibilitychange",
            this.onVisibility
        );

        document.removeEventListener(
            "pointerlockchange",
            this.onPointerLockChange
        );

        this.surface.removeEventListener("focus", this.onSurfaceFocus);
        this.surface.removeEventListener("click", this.onSurfaceClick);
        this.surface.removeEventListener("mousemove", this.onMouseMove);
        this.surface.removeEventListener("mousedown", this.onMouseDown);
        this.surface.removeEventListener("contextmenu", this.onContextMenu);
    }
}

// ---------- WEBRTC ----------

function updatePlayingState(): void {
    const video = $("game-video") as HTMLVideoElement | null;

    if (
        peer?.connectionState === "connected" &&
        inputChannel?.readyState === "open" &&
        video?.srcObject
    ) {
        setState("PLAYING");
    }
}

function failSession(message: string): void {
    if (cleaning || state === "ERROR") return;

    void cleanupSession(false).then(() => {
        setState("ERROR");
        setText("game-message", "Соединение потеряно");
        setText("game-description", message);
        setText("game-error", message);
        show("game-placeholder");
        hide("game-loader");
    });
}

async function connectToGame(session: SessionInfo): Promise<void> {
    setState("SIGNALING");

    const video = $("game-video") as HTMLVideoElement | null;
    const surface = $("game-surface");

    if (!video || !surface) {
        throw new Error("Не найден игровой video/container в HTML.");
    }

    localIceComplete = false;
    remoteIceComplete = false;
    remoteDescriptionSet = false;
    connectionEstablished = false;
    signalingAuthenticated = false;
    signalingClosedIntentionally = false;
    pendingCandidates = [];

    peer = new RTCPeerConnection({
        iceServers: config.iceServers ?? []
    });

    peer.addTransceiver("video", {
        direction: "recvonly"
    });

    inputChannel = peer.createDataChannel("game-input", {
        ordered: false,
        maxRetransmits: 0
    });

    inputChannel.onopen = () => {
        if (inputChannel && surface) {
            inputController = new InputController(
                inputChannel,
                surface
            );
        }

        updatePlayingState();
    };

    inputChannel.onclose = () => {
        inputController?.destroy();
        inputController = null;
    };

    inputChannel.onerror = () => {
        failSession("Ошибка DataChannel.");
    };

    peer.ontrack = async event => {
        const stream = event.streams[0];

        if (!stream) {
            failSession("Получен видеотрек без MediaStream.");
            return;
        }

        video.srcObject = stream;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;

        try {
            await video.play();
            hide("manual-play");
        } catch {
            show("manual-play");
            setText(
                "game-message",
                "Нажмите, чтобы начать воспроизведение"
            );
        }

        updatePlayingState();
    };

    peer.onicecandidate = event => {
        if (event.candidate) {
            try {
                sendSignal({
                    type: "ice-candidate",
                    candidate: event.candidate.toJSON()
                });
            } catch (error) {
                failSession(String(error));
            }
        } else {
            localIceComplete = true;

            try {
                sendSignal({ type: "ice-complete" });
            } catch (error) {
                failSession(String(error));
            }

            maybeCloseSignaling();
        }
    };

    peer.oniceconnectionstatechange = () => {
        if (!peer) return;

        const iceState = peer.iceConnectionState;

        if (iceState === "connected" || iceState === "completed") {
            if (disconnectTimer !== null) {
                clearTimeout(disconnectTimer);
                disconnectTimer = null;
            }
        }

        if (iceState === "disconnected") {
            if (disconnectTimer !== null) {
                clearTimeout(disconnectTimer);
            }

            setText(
                "game-message",
                "Соединение прервано. Ожидаем восстановления."
            );

            disconnectTimer = window.setTimeout(() => {
                if (
                    peer?.iceConnectionState === "disconnected"
                ) {
                    failSession("Соединение с Game Agent потеряно.");
                }
            }, DISCONNECT_GRACE);
        }

        if (iceState === "failed") {
            failSession("ICE-соединение не удалось установить.");
        }
    };

    peer.onconnectionstatechange = () => {
        if (!peer || cleaning) return;

        if (peer.connectionState === "connected") {
            connectionEstablished = true;

            if (disconnectTimer !== null) {
                clearTimeout(disconnectTimer);
                disconnectTimer = null;
            }

            updatePlayingState();
            maybeCloseSignaling();
        }

        if (peer.connectionState === "failed") {
            failSession("WebRTC-соединение завершилось с ошибкой.");
        }
    };

    socket = new WebSocket(signalingURL(session));

    const ws = socket;

    let resolveAuth!: () => void;
    let rejectAuth!: (error: Error) => void;

    const authenticated = new Promise<void>((resolve, reject) => {
        resolveAuth = resolve;
        rejectAuth = reject;
    });

    ws.onmessage = event => {
        try {
            const message = JSON.parse(event.data) as Record<string, unknown>;

            handleSignalingMessage(
                message,
                session,
                resolveAuth
            );
        } catch (error) {
            rejectAuth(
                error instanceof Error ? error : new Error(String(error))
            );

            failSession(String(error));
        }
    };

    ws.onerror = () => {
        rejectAuth(new Error("Ошибка WebSocket signaling."));
    };

    ws.onclose = () => {
        if (
            !signalingClosedIntentionally &&
            !cleaning
        ) {
            failSession("WebSocket закрыт до завершения сигналинга.");
        }
    };

    await waitForSocketOpen(ws);

    // Authenticate MUST be the first application message.
    sendSignal({
        type: "authenticate",
        token: session.sessionToken
    });

    await withTimeout(
        authenticated,
        SIGNALING_TIMEOUT,
        "Таймаут аутентификации Game Agent."
    );

    if (!signalingAuthenticated) {
        throw new Error("Game Agent не подтвердил сессию.");
    }

    const offer = await peer.createOffer();

    await peer.setLocalDescription(offer);

    sendSignal({
        type: "offer",
        sdp: peer.localDescription?.sdp
    });

    setState("CONNECTING");

    await withTimeout(
        new Promise<void>((resolve, reject) => {
            const check = () => {
                if (peer?.connectionState === "connected") {
                    resolve();
                } else if (
                    peer?.connectionState === "failed" ||
                    peer?.connectionState === "closed"
                ) {
                    reject(new Error("WebRTC не удалось установить."));
                } else {
                    connectionTimer = window.setTimeout(check, 100);
                }
            };

            check();
        }),
        CONNECTION_TIMEOUT,
        "Таймаут подключения WebRTC."
    );

    maybeCloseSignaling();
}

// ---------- GAME SESSION ----------

async function startGame(gameId: string): Promise<void> {
    if (
        starting ||
        state === "ALLOCATING" ||
        state === "SIGNALING" ||
        state === "CONNECTING" ||
        state === "PLAYING" ||
        state === "CLEANUP"
    ) {
        return;
    }

    if (gameId !== "doom") return;

    starting = true;
    const currentRun = ++runId;

    show("game-screen");
    hide("catalog-screen");
    hide("details-screen");

    setText("game-title", "DOOM");
    setText("game-message", "Подготавливаем игровую сессию");
    setText(
        "game-description",
        "Подождите, пока мы подключимся к игровому серверу."
    );
    setText("session-label", "СЕССИЯ: СОЗДАЁТСЯ");
    setText("game-error", "");

    show("game-placeholder");
    show("game-loader");
    hide("manual-play");

    try {
        checkBrowser();

        setState("ALLOCATING");

        await checkBackend();
        if (currentRun !== runId) return;

        const session = await createSession(gameId);
        if (currentRun !== runId) return;

        currentSession = session;

        setText("session-label", `СЕССИЯ: ${session.sessionId}`);
        setText("game-description", `Сервер: ${session.server.host}`);

        await connectToGame(session);
        if (currentRun !== runId) return;
    } catch (error) {
        if (currentRun !== runId) return;

        const message = error instanceof Error
            ? error.message
            : "Неизвестная ошибка.";

        await cleanupSession(false);

        setState("ERROR");
        setText("game-message", "Не удалось запустить игру");
        setText("game-description", message);
        setText("game-error", message);

        show("game-placeholder");
        hide("game-loader");
    } finally {
        if (currentRun === runId) {
            starting = false;
        }
    }
}

async function cleanupSession(returnToIdle = true): Promise<void> {
    if (cleaning) return;

    cleaning = true;
    runId++;
    starting = false;

    setState("CLEANUP");

    requestController?.abort();
    requestController = null;

    if (disconnectTimer !== null) {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
    }

    if (connectionTimer !== null) {
        clearTimeout(connectionTimer);
        connectionTimer = null;
    }

    inputController?.destroy();
    inputController = null;

    const surface = $("game-surface");

    if (
        surface &&
        document.pointerLockElement === surface
    ) {
        document.exitPointerLock();
    }

    if (inputChannel) {
        try {
            inputChannel.close();
        } catch {
            // Канал уже закрыт.
        }

        inputChannel = null;
    }

    if (peer) {
        try {
            peer.getReceivers().forEach(receiver => {
                receiver.track?.stop();
            });

            peer.close();
        } catch {
            // PeerConnection уже закрыт.
        }

        peer = null;
    }

    if (socket) {
        try {
            signalingClosedIntentionally = true;
            socket.close(1000, "Session cleanup");
        } catch {
            // WebSocket уже закрыт.
        }

        socket = null;
    }

    const video = $("game-video") as HTMLVideoElement | null;

    if (video) {
        video.pause();
        video.srcObject = null;
    }

    currentSession = null;
    pendingCandidates = [];

    localIceComplete = false;
    remoteIceComplete = false;
    remoteDescriptionSet = false;
    connectionEstablished = false;
    signalingAuthenticated = false;

    cleaning = false;

    if (returnToIdle) {
        setState("IDLE");
    }
}

// ---------- NAVIGATION ----------

function renderCatalog(): void {
    show("catalog-screen");
    hide("details-screen");
    hide("game-screen");
}

function openDetails(gameId: string): void {
    hide("catalog-screen");
    hide("game-screen");
    show("details-screen");

    const titles: Record<string, string> = {
        doom: "DOOM",
        quake: "QUAKE",
        "half-life": "HALF-LIFE",
        "counter-strike": "COUNTER-STRIKE"
    };

    setText("details-title", titles[gameId] ?? gameId);

    if (gameId === "doom") {
        setText("details-status", "ДОСТУПНА");
        setText("details-subtitle", "Крушите демонов.");
        setText(
            "details-description",
            "Легендарный шутер от первого лица. Исследуйте марсианскую базу, сражайтесь с демонами и пробивайте себе путь через орды монстров."
        );
        setText("details-genre", "ШУТЕР / ЭКШЕН");
        setText("details-year", "1993");

        show("details-play");
        hide("details-unavailable");
    } else {
        setText("details-status", "СКОРО");
        setText("details-subtitle", "Эта игра пока не подключена.");
        setText("details-description", "");
        setText("details-genre", "");
        setText("details-year", "");

        hide("details-play");
        show("details-unavailable");
    }

    const art = $("details-art");

    if (art) {
        art.className = `details-art ${gameId}`;
    }
}

function navigate(route: string): void {
    history.pushState({}, "", `#${route}`);
    void renderRoute();
}

async function renderRoute(): Promise<void> {
    const route = location.hash.replace(/^#/, "");
    const normalized = !route || route === "library" ? "catalog" : route;

    if (
        renderedRoute.startsWith("play/") &&
        renderedRoute !== normalized
    ) {
        await cleanupSession();
    }

    renderedRoute = normalized;

    const [page, gameId] = normalized.split("/");

    if (page === "details" && gameId) {
        openDetails(gameId);
    } else if (page === "play" && gameId) {
        void startGame(gameId);
    } else {
        renderCatalog();
    }
}

// ---------- EVENTS ----------

function registerEvents(): void {
    document.addEventListener("click", event => {
        const target = event.target as HTMLElement;

        const play = target.closest<HTMLElement>("[data-play-game]");
        const details = target.closest<HTMLElement>("[data-open-game]");

        if (play) {
            event.preventDefault();

            const gameId = play.dataset.playGame;

            if (gameId) navigate(`play/${gameId}`);

            return;
        }

        if (details) {
            event.preventDefault();

            const gameId = details.dataset.openGame;

            if (gameId) navigate(`details/${gameId}`);
        }
    });

    $("details-back")?.addEventListener("click", () => {
        navigate("catalog");
    });

    $("details-play")?.addEventListener("click", () => {
        navigate("play/doom");
    });

    $("exit-game")?.addEventListener("click", async () => {
        await cleanupSession();
        navigate("catalog");
    });

    $("brand-home")?.addEventListener("click", async event => {
        event.preventDefault();
        await cleanupSession();
        navigate("catalog");
    });

    $("footer-home")?.addEventListener("click", async event => {
        event.preventDefault();
        await cleanupSession();
        navigate("catalog");
    });

    $("manual-play")?.addEventListener("click", () => {
        const video = $("game-video") as HTMLVideoElement | null;

        if (!video) return;

        void video.play().then(() => {
            hide("manual-play");
        }).catch(() => {
            setText("game-error", "Не удалось запустить видео.");
        });
    });

    window.addEventListener("popstate", () => {
        void renderRoute();
    });

    window.addEventListener("beforeunload", () => {
        requestController?.abort();
        inputController?.destroy();
        inputChannel?.close();
        peer?.close();
        socket?.close();
    });
}

// ---------- INITIALIZATION ----------

async function initialize(): Promise<void> {
    registerEvents();

    try {
        checkBrowser();

        setText("platform-status", "ПРОВЕРКА СЕРВИСА");

        await checkBackend();

        setText("platform-status", "СЕРВИС ДОСТУПЕН");
        $("platform-dot")?.classList.remove("status-error");
    } catch (error) {
        setText("platform-status", "СЕРВИС НЕДОСТУПЕН");
        $("platform-dot")?.classList.add("status-error");

        console.error(error);
    }

    await renderRoute();
}

void initialize();
