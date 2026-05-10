require("events").EventEmitter.defaultMaxListeners = 960;

const {
    default: giftedConnect,
    DisconnectReason,
    fetchLatestWaWebVersion,
    generateWAMessageFromContent,
    jidNormalizedUser,
    makeCacheableSignalKeyStore,
    proto,
} = require("gifted-baileys");
const { Boom } = require("@hapi/boom");
const axios = require("axios");
const express = require("express");
const fs = require("fs-extra");
const NodeCache = require("node-cache");
const path = require("path");
const pino = require("pino");
const { randomBytes } = require("crypto");

const config = require("./config");
const { loadSession, useSQLiteAuthState } = require("./gift/gmdFunctions");

const PORT = process.env.PORT || 5000;
const GEMINI_ENDPOINT = "https://apis.davidcyril.name.ng/ai/gemini";
const BOT_STARTED_MESSAGE = "Chat bot connected";
const AUTOCHAT_STATE_FILE = path.join(__dirname, "gift", "database", "autochat.json");
const sessionDir = path.join(__dirname, "gift", "session");

const app = express();
let Gifted;
let reconnectAttempts = 0;
let autochatEnabled = loadAutochatState();
const processedMessages = new Set();
const userDevicesCache = new NodeCache({ stdTTL: 1800, useClones: false });

app.use(express.static("gift"));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "gift", "gifted.html")));
app.get("/health", (req, res) =>
    res.status(200).json({
        status: "alive",
        autochat: autochatEnabled ? "on" : "off",
        uptime: process.uptime(),
    }),
);
app.listen(PORT, () => console.log(`✅ Server Running on Port: ${PORT}`));

setInterval(() => {
    const used = process.memoryUsage();
    if (used.heapUsed > 400 * 1024 * 1024 && global.gc) global.gc();
}, 60000);

setInterval(() => {
    try {
        require("http").get(`http://localhost:${PORT}/health`, () => {});
    } catch (_) {}
}, 240000);

function loadAutochatState() {
    try {
        const saved = fs.readJsonSync(AUTOCHAT_STATE_FILE);
        return saved.enabled !== false;
    } catch (_) {
        return true;
    }
}

async function saveAutochatState(enabled) {
    autochatEnabled = enabled;
    await fs.ensureDir(path.dirname(AUTOCHAT_STATE_FILE));
    await fs.writeJson(AUTOCHAT_STATE_FILE, { enabled }, { spaces: 2 });
}

function createSocketConfig(version, state) {
    return {
        version,
        logger: pino({ level: "silent" }),
        browser: ["Ubuntu", "Chrome", "22.04.4"],
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        userDevicesCache,
        connectTimeoutMs: 15000,
        defaultQueryTimeoutMs: 20000,
        keepAliveIntervalMs: 20000,
        fireInitQueries: false,
        markOnlineOnConnect: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        retryRequestDelayMs: 50,
        maxMsgRetryCount: 2,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
        emitOwnEvents: true,
    };
}

function isDirectChat(jid = "") {
    return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

function unwrapMessage(message) {
    if (!message) return null;
    return (
        message.ephemeralMessage?.message ||
        message.viewOnceMessage?.message ||
        message.viewOnceMessageV2?.message ||
        message.documentWithCaptionMessage?.message ||
        message
    );
}

function getMessageText(message) {
    const msg = unwrapMessage(message);
    if (!msg) return "";

    return (
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.documentMessage?.caption ||
        msg.buttonsResponseMessage?.selectedDisplayText ||
        msg.buttonsResponseMessage?.selectedButtonId ||
        msg.listResponseMessage?.title ||
        msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
        msg.templateButtonReplyMessage?.selectedDisplayText ||
        msg.templateButtonReplyMessage?.selectedId ||
        ""
    ).trim();
}

function parseAutochatCommand(text) {
    const normalized = text.toLowerCase().trim().replace(/^\./, "").replace(/\s+/g, " ");
    if (normalized === "autochat on") return true;
    if (normalized === "autochat off") return false;
    return null;
}

async function askGemini(text) {
    const { data } = await axios.get(GEMINI_ENDPOINT, {
        params: { text },
        timeout: 30000,
        responseType: "json",
    });

    if (!data?.success || !data?.message) {
        throw new Error("Gemini API returned an empty response");
    }

    return String(data.message).trim();
}

async function sendAiTaggedMessage(jid, text, quoted) {
    const botJid = jidNormalizedUser(Gifted.user?.id || "");
    const message = proto.Message.fromObject({
        extendedTextMessage: {
            text,
            contextInfo: {
                stanzaId: quoted?.key?.id,
                participant: quoted?.key?.participant || quoted?.key?.remoteJid,
                quotedMessage: unwrapMessage(quoted?.message),
            },
        },
        messageContextInfo: {
            botMessageSecret: randomBytes(32),
            botMetadata: {
                invokerJid: jid,
                messageDisclaimerText: "AI generated",
                capabilityMetadata: {
                    capabilities: [
                        proto.BotCapabilityMetadata.BotCapabilityType.RICH_RESPONSE_HEADING,
                        proto.BotCapabilityMetadata.BotCapabilityType.RICH_RESPONSE_STRUCTURED_RESPONSE,
                    ],
                },
            },
        },
    });

    const waMessage = generateWAMessageFromContent(jid, message, { userJid: botJid });
    await Gifted.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
}

async function sendReply(jid, text, quoted) {
    try {
        await sendAiTaggedMessage(jid, text, quoted);
    } catch (error) {
        console.error("AI tagged send failed, falling back to normal text:", error.message);
        await Gifted.sendMessage(jid, { text }, { quoted });
    }
}

function setupAutochat(Gifted) {
    Gifted.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type === "append") return;

        for (const message of messages || []) {
            try {
                if (!message?.message || !message?.key?.remoteJid) continue;
                if (message.key.remoteJid === "status@broadcast") continue;
                if (!isDirectChat(message.key.remoteJid)) continue;

                const messageId = message.key.id;
                if (processedMessages.has(messageId)) continue;
                processedMessages.add(messageId);
                setTimeout(() => processedMessages.delete(messageId), 60000);

                const from = message.key.remoteJid;
                const text = getMessageText(message.message);
                if (!text) continue;

                const commandState = parseAutochatCommand(text);
                if (commandState !== null) {
                    await saveAutochatState(commandState);
                    await Gifted.sendMessage(from, {
                        text: `Autochat ${commandState ? "on" : "off"}`,
                    }, { quoted: message });
                    continue;
                }

                if (!autochatEnabled || message.key.fromMe) continue;

                await Gifted.presenceSubscribe(from).catch(() => {});
                await Gifted.sendPresenceUpdate("composing", from).catch(() => {});

                const response = await askGemini(text);
                await sendReply(from, response, message);

                await Gifted.sendPresenceUpdate("paused", from).catch(() => {});
            } catch (error) {
                console.error("Autochat error:", error.message);
            }
        }
    });
}

async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect } = update;

    if (connection === "connecting") {
        console.log("🕗 Connecting Bot...");
    }

    if (connection === "open") {
        reconnectAttempts = 0;
        console.log("✅ Chat bot connected");
        try {
            await Gifted.sendMessage(jidNormalizedUser(Gifted.user.id), { text: BOT_STARTED_MESSAGE });
        } catch (error) {
            console.error("Startup message failed:", error.message);
        }
    }

    if (connection === "close") {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`Connection closed due to: ${reason}`);

        if (
            reason === DisconnectReason.badSession ||
            reason === DisconnectReason.connectionReplaced ||
            reason === DisconnectReason.loggedOut
        ) {
            if (reason !== DisconnectReason.connectionReplaced) {
                await fs.remove(sessionDir).catch(() => {});
            }
            process.exit(1);
        }

        reconnectAttempts += 1;
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 300000);
        console.log(`🕗 Reconnecting in ${delay}ms...`);
        setTimeout(() => startGifted(), delay);
    }
}

async function startGifted() {
    try {
        const { version } = await fetchLatestWaWebVersion();
        const sessionDbPath = path.join(sessionDir, "session.db");
        const { state, saveCreds } = await useSQLiteAuthState(sessionDbPath);

        Gifted = giftedConnect(createSocketConfig(version, state));
        Gifted.ev.process(async (events) => {
            if (events["creds.update"]) await saveCreds();
        });
        Gifted.ev.on("connection.update", handleConnectionUpdate);
        setupAutochat(Gifted);
    } catch (error) {
        console.error("Socket initialization error:", error.message);
        setTimeout(() => startGifted(), 5000);
    }
}

(async () => {
    if (config.SESSION_ID) await loadSession();
    await startGifted();
})();
