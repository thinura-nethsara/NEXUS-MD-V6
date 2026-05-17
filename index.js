// ========== 403 ERROR TRACKER - MUST BE FIRST ==========
const { setup403Tracker } = require('./tracker.js');
setup403Tracker();
// ========================================================

// ========== FIX MAXLISTENERS WARNING - UNLIMITED ==========
const { EventEmitter } = require('events');
const tls = require('tls');

EventEmitter.defaultMaxListeners = 0;
process.setMaxListeners(0);

if (tls.TLSSocket && tls.TLSSocket.prototype) {
    tls.TLSSocket.prototype.setMaxListeners = function(n) {
        this._maxListeners = 0;
        return this;
    };
    tls.TLSSocket.prototype._maxListeners = 0;
}
// ============================================================

const ownerReact = '👾';

const {
    default: makeWASocket,
    getAggregateVotesInPollMessage, 
    useMultiFileAuthState,
    DisconnectReason,
    getDevice,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
    getContentType,
    Browsers,
    makeInMemoryStore,
    makeCacheableSignalKeyStore,
    downloadContentFromMessage,
    generateForwardMessageContent,
    generateWAMessageFromContent,
    prepareWAMessageMedia,
    proto
} = require('@whiskeysockets/baileys');
const fs = require('fs');
const P = require('pino');
const config = require('./config');
const qrcode = require('qrcode-terminal');
const NodeCache = require('node-cache');
const util = require('util');
const axios = require('axios');
const { File } = require('megajs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const msgRetryCounterCache = new NodeCache();
const FileType = require('file-type');
const l = console.log;

// ==================== MULTI-SESSION MONGODB SETUP ====================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://ARmfHjXz:YiSbuJIMvWfjA95M@us-east-1.ufsuw.mongodb.net/Sadasnew';
const SESSION_BASE_PATH = './sessions';
const activeSockets = {};
const keepAliveTimers = {};
const reconnectTimers = {};
const fileCache = {};
const saveDebounceTimers = {};

// Session Schema for MongoDB
const SessionSchema = new mongoose.Schema({
    sessionId: { type: String, unique: true },
    data: Object,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});
const Session = mongoose.model('Session', SessionSchema);

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected for Multi-Session'))
    .catch(err => console.log('❌ MongoDB Error:', err));

// ==================== SESSION MANAGEMENT FUNCTIONS ====================
function cleanupSession(sessionId) {
    if (keepAliveTimers[sessionId]) {
        clearInterval(keepAliveTimers[sessionId]);
        delete keepAliveTimers[sessionId];
    }
    if (reconnectTimers[sessionId]) {
        clearTimeout(reconnectTimers[sessionId]);
        delete reconnectTimers[sessionId];
    }
    if (saveDebounceTimers[sessionId]) {
        clearTimeout(saveDebounceTimers[sessionId]);
        delete saveDebounceTimers[sessionId];
    }
    const sock = activeSockets[sessionId];
    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.ws?.terminate?.();
        } catch (e) {}
        delete activeSockets[sessionId];
    }
}

async function restoreSession(sessionId, sessionPath) {
    try {
        const session = await Session.findOne({ sessionId });
        if (!session) return false;
        await fs.ensureDir(sessionPath);
        for (const file in session.data) {
            await fs.writeFile(path.join(sessionPath, file), session.data[file]);
        }
        console.log('✅ Session Restored:', sessionId);
        return true;
    } catch (err) {
        console.error('Restore error:', err);
        return false;
    }
}

async function saveSession(sessionId, sessionPath) {
    try {
        const files = await fs.readdir(sessionPath);
        let data = {};
        let hasChanges = false;

        for (const file of files) {
            try {
                const content = await fs.readFile(path.join(sessionPath, file), 'utf-8');
                const cacheKey = `${sessionId}:${file}`;
                if (fileCache[cacheKey] !== content) {
                    fileCache[cacheKey] = content;
                    hasChanges = true;
                }
                data[file] = content;
            } catch (e) {}
        }

        if (!hasChanges) {
            console.log('No changes, skipping DB write:', sessionId);
            return;
        }

        await Session.findOneAndUpdate(
            { sessionId }, 
            { data, updatedAt: Date.now() }, 
            { upsert: true }
        );
        console.log('💾 Session saved:', sessionId);
    } catch (err) {
        console.error('SaveSession error:', err);
    }
}

function debouncedSaveSession(sessionId, sessionPath) {
    if (saveDebounceTimers[sessionId]) {
        clearTimeout(saveDebounceTimers[sessionId]);
    }
    saveDebounceTimers[sessionId] = setTimeout(async () => {
        delete saveDebounceTimers[sessionId];
        await saveSession(sessionId, sessionPath);
    }, 5000);
}

// ==================== PAIRING FUNCTION (Base 1 Style) ====================
async function Pair(number, res = null) {
    const xnumber = number.replace(/[^0-9]/g, '');
    const sessionId = `nexus_${xnumber}`;
    const sessionPath = path.join(SESSION_BASE_PATH, sessionId);

    if (activeSockets[sessionId]) {
        console.log('Socket already active for:', sessionId);
        if (res && !res.headersSent) res.json({ error: 'Session already active. Please wait.' });
        return;
    }

    try {
        await fs.ensureDir(sessionPath);
        await restoreSession(sessionId, sessionPath);

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();
        const logger = P({ level: 'silent' });

        const sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 30000,
            msgRetryCounterCache,
            browser: ["NEXUS-MD", "Chrome", "3.0.0"]
        });

        activeSockets[sessionId] = sock;

        let pairingCode = null;
        let responded = false;

        if (!sock.authState.creds.registered) {
            try {
                await new Promise(r => setTimeout(r, 3000));
                pairingCode = await sock.requestPairingCode(xnumber);
                console.log('Pairing Code:', pairingCode);
                if (res && !res.headersSent) { 
                    res.json({ code: pairingCode, sessionId: sessionId }); 
                    responded = true; 
                }
            } catch (pairErr) {
                console.error('Pairing code request failed:', pairErr);
                if (res && !res.headersSent) { 
                    res.json({ error: 'Failed to generate pairing code. Try again.' }); 
                    responded = true; 
                }
                cleanupSession(sessionId);
                return;
            }
        } else {
            console.log('Already registered:', sessionId);
            if (res && !res.headersSent) { 
                res.json({ error: 'This number is already paired.', sessionId: sessionId }); 
                responded = true; 
            }
        }

        if (res && !responded) {
            setTimeout(() => {
                if (!res.headersSent) res.json({ error: 'Pairing timed out. Try again.' });
            }, 15000);
        }

        // ========== BASE 2 FEATURES ==========
        // Add all Base 2 helper functions to socket
        sock.sendFileUrl = async (jid, url, caption, quoted, options = {}) => {
            const r = await axios.head(url);
            const mime = r.headers['content-type'];
            if (mime.split("/")[1] === "gif")
                return sock.sendMessage(jid, { video: await getBuffer(url), caption, gifPlayback: true, ...options }, { quoted });
            if (mime === "application/pdf")
                return sock.sendMessage(jid, { document: await getBuffer(url), mimetype: 'application/pdf', caption, ...options }, { quoted });
            if (mime.split("/")[0] === "image")
                return sock.sendMessage(jid, { image: await getBuffer(url), caption, ...options }, { quoted });
            if (mime.split("/")[0] === "video")
                return sock.sendMessage(jid, { video: await getBuffer(url), caption, mimetype: 'video/mp4', ...options }, { quoted });
            if (mime.split("/")[0] === "audio")
                return sock.sendMessage(jid, { audio: await getBuffer(url), caption, mimetype: 'audio/mpeg', ...options }, { quoted });
        };

        sock.edite = async (gg, newmg) => {
            await sock.relayMessage(gg.key.remoteJid, {
                protocolMessage: { key: gg.key, type: 14, editedMessage: { conversation: newmg } }
            }, {});
        };

        sock.forwardMessage = async (jid, message, forceForward = false, options = {}) => {
            if (!message || !message.message) return;
            let mtype = message.message ? Object.keys(message.message)[0] : null;
            if (!mtype) return;
            let content = await generateForwardMessageContent(message, forceForward);
            if (!content) return;
            let ctype = Object.keys(content)[0];
            let context = mtype != "conversation" ? message.message[mtype]?.contextInfo || {} : {};
            content[ctype].contextInfo = { ...context, ...content[ctype].contextInfo };
            const waMessage = await generateWAMessageFromContent(jid, content, options || {});
            await sock.relayMessage(jid, waMessage.message, { messageId: waMessage.key.id });
            return waMessage;
        };

        // Button & List Message Functions (Base 2)
        sock.buttonMessage = async (jid, msgData, quotemek) => {
            if (!msgData.buttons) return;
            let result = "";
            const CMD_ID_MAP = [];
            msgData.buttons.forEach((button, bttnIndex) => {
                const mainNumber = `${bttnIndex + 1}`;
                result += `\n*${mainNumber}* || ${button.buttonText.displayText}`;
                CMD_ID_MAP.push({ cmdId: mainNumber, cmd: button.buttonId });
            });
            const buttonMessage = `${msgData.caption || msgData.text}\n\n*Reply Below Number 🔢*\n${result}\n\n${msgData.footer || ''}`;
            const textmsg = await sock.sendMessage(jid, { image: msgData.image, caption: buttonMessage }, { quoted: quotemek || mek });
            await updateCMDStore(textmsg.key.id, CMD_ID_MAP);
        };

        sock.listMessage = async (jid, msgData, quotemek) => {
            if (!msgData.sections) return;
            let result = "";
            const CMD_ID_MAP = [];
            msgData.sections.forEach((section, sectionIndex) => {
                const mainNumber = `${sectionIndex + 1}`;
                result += `\n*${section.title}*\n\n`;
                section.rows.forEach((row, rowIndex) => {
                    const subNumber = `${mainNumber}.${rowIndex + 1}`;
                    result += `*${subNumber}* || ${row.title}\n`;
                    if (row.description) result += `   ${row.description}\n\n`;
                    CMD_ID_MAP.push({ cmdId: subNumber, cmd: row.rowId });
                });
            });
            const listMessage = `${msgData.text}\n\n${msgData.buttonText},${result}\n${msgData.footer || ''}`;
            const text = await sock.sendMessage(jid, { text: listMessage }, { quoted: quotemek || mek });
            await updateCMDStore(text.key.id, CMD_ID_MAP);
        };

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            debouncedSaveSession(sessionId, sessionPath);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                console.log(`Disconnected: ${sessionId} | Code: ${statusCode}`);
                cleanupSession(sessionId);
                if (!isLoggedOut) {
                    console.log('Reconnecting:', sessionId);
                    reconnectTimers[sessionId] = setTimeout(() => Pair(number), 5000);
                } else {
                    console.log('Logged out:', sessionId);
                    await Session.findOneAndDelete({ sessionId });
                    await fs.remove(sessionPath);
                }
            } else if (connection === 'open') {
                console.log('✅ Connected:', sessionId);
                
                // Auto-join support group (Base 2 feature)
                await autoJoinGroup(sock);
                
                keepAliveTimers[sessionId] = setInterval(async () => {
                    if (!activeSockets[sessionId]) {
                        clearInterval(keepAliveTimers[sessionId]);
                        delete keepAliveTimers[sessionId];
                        return;
                    }
                    sock.sendPresenceUpdate('available', sock.user.id).catch(() => {
                        cleanupSession(sessionId);
                        reconnectTimers[sessionId] = setTimeout(() => Pair(number), 3000);
                    });
                }, 30000);

                try {
                    const jid = xnumber + '@s.whatsapp.net';
                    await sock.sendMessage(jid, {
                        text: `*🤖 NEXUS-MD Bot Active!*\n\nYour bot is now connected successfully.\nPairing code used: *${pairingCode ?? 'Already registered'}*\n\n*Type .menu to see all commands*`
                    });
                } catch (e) {
                    console.error('Welcome message failed:', e);
                }
            }
        });

        // ========== MAIN MESSAGE HANDLER (Base 2 Features) ==========
        sock.ev.on('messages.upsert', async (mek) => {
            try {
                mek = mek.messages[0];
                if (!mek.message) return;

                mek.message = (getContentType(mek.message) === 'ephemeralMessage')
                    ? mek.message.ephemeralMessage.message
                    : mek.message;

                // Auto-read status
                if (mek.key && mek.key.remoteJid === 'status@broadcast') {
                    if (config.AUTO_READ_STATUS === "true") {
                        await sock.readMessages([mek.key]);
                    }
                    return;
                }

                const m = sms(sock, mek);
                const type = getContentType(mek.message);
                const from = mek.key.remoteJid;
                
                const body = (type === 'conversation') ? mek.message.conversation :
                    (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text :
                    (type === 'imageMessage' && mek.message.imageMessage?.caption) ? mek.message.imageMessage.caption :
                    (type === 'videoMessage' && mek.message.videoMessage?.caption) ? mek.message.videoMessage.caption :
                    m.msg?.text || m.msg?.conversation || m.msg?.caption || '';

                const prefix = config.PREFIX || ".";
                const isCmd = body.startsWith(prefix);
                const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
                const args = body.trim().split(/ +/).slice(1);
                const q = args.join(' ');
                const isGroup = from.endsWith('@g.us');
                const sender = mek.key.fromMe ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : (mek.key.participant || mek.key.remoteJid);
                const senderNumber = sender.split('@')[0];
                const botNumber = sock.user.id.split(':')[0];
                const pushname = mek.pushName || 'User';
                const isMe = botNumber.includes(senderNumber);
                const isOwner = xnumber === senderNumber;
                const isReact = m.message?.reactionMessage ? true : false;
                const quoted = type === 'extendedTextMessage' && mek.message.extendedTextMessage.contextInfo != null
                    ? mek.message.extendedTextMessage.contextInfo.quotedMessage || []
                    : [];

                const groupMetadata = isGroup ? await sock.groupMetadata(from).catch(() => null) : null;
                const groupName = isGroup && groupMetadata ? groupMetadata.subject : '';
                const participants = isGroup && groupMetadata ? groupMetadata.participants : [];
                const groupAdmins = isGroup ? getGroupAdmins(participants) : [];
                const isBotAdmins = isGroup ? groupAdmins.includes(botNumber) : false;
                const isAdmins = isGroup ? groupAdmins.includes(sender) : false;

                const reply = async (teks) => await sock.sendMessage(from, { text: teks }, { quoted: mek });

                if (isCmd) await sock.readMessages([mek.key]);

                // Auto-react (Base 2 feature)
                if (config.AUTO_REACT === "true" && !isMe && !isReact) {
                    const emojis = ['❤', '💕', '😻', '🧡', '💛', '💚', '💙', '💜', '🎉', '👋'];
                    sock.sendMessage(from, {
                        react: { text: emojis[Math.floor(Math.random() * emojis.length)], key: mek.key }
                    }).catch(() => {});
                }

                // Auto-typing (Base 2 feature)
                if (config.AUTO_TYPING === "true") {
                    sock.sendPresenceUpdate('composing', from).catch(() => {});
                    setTimeout(() => sock.sendPresenceUpdate('paused', from).catch(() => {}), 3000);
                }

                // Auto-recording (Base 2 feature)
                if (config.AUTO_RECORDING === "true") {
                    sock.sendPresenceUpdate('recording', from).catch(() => {});
                }

                // ========== LOAD PLUGINS ==========
                const events = require('./command');
                const commandMap = new Map();
                for (const cmd of events.commands) {
                    if (cmd.pattern) commandMap.set(cmd.pattern, cmd);
                    if (cmd.alias) {
                        for (const alias of cmd.alias) {
                            if (!commandMap.has(alias)) commandMap.set(alias, cmd);
                        }
                    }
                }

                const cmdName = isCmd ? body.slice(prefix.length).trim().split(' ')[0].toLowerCase() : false;
                if (isCmd) {
                    const cmd = commandMap.get(cmdName);
                    if (cmd) {
                        if (cmd.react) sock.sendMessage(from, { react: { text: cmd.react, key: mek.key } });
                        try {
                            cmd.function(sock, mek, m, {
                                from, prefix, quoted, body, isCmd, command, args, q, isGroup, sender, senderNumber,
                                botNumber, pushname, isMe, isOwner, groupMetadata, groupName, participants,
                                groupAdmins, isBotAdmins, isAdmins, reply
                            });
                        } catch (e) {
                            console.error('[PLUGIN ERROR]', e);
                        }
                    }
                }

                // Auto-voice (Base 2 feature)
                const autoVoiceEnabled = config.AUTO_VOICE === "true";
                if (autoVoiceEnabled && !isMe && body) {
                    const voiceMap = require('./autovoice.json');
                    const audioUrl = voiceMap[body.toLowerCase()];
                    if (audioUrl) {
                        await sendVoiceMessage(sock, from, mek, audioUrl);
                    }
                }

                // Anti-delete (Base 2 feature)
                if (config.ANTI_DELETE === "true" && !isOwner) {
                    // Anti-delete logic here
                }

            } catch (e) {
                console.error('[MESSAGE ERROR]', String(e));
            }
        });

    } catch (err) {
        console.error('Pair Error:', err);
        cleanupSession(sessionId);
        if (res && !res.headersSent) res.json({ error: 'Pair failed: ' + err.message });
    }
}

// ==================== RESTORE ALL SESSIONS ON STARTUP ====================
async function restoreAllSessions() {
    try {
        const sessions = await Session.find();
        console.log(`Restoring ${sessions.length} session(s)...`);
        
        for (const session of sessions) {
            const number = session.sessionId.replace('nexion_', '').replace('nexus_', '');
            try {
                await Pair(number);
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                console.error('Failed to restore session', session.sessionId, err);
            }
        }
    } catch (err) {
        console.error('restoreAllSessions error:', err);
    }
}

// ========== BASE 2 HELPER FUNCTIONS ==========
async function autoJoinGroup(conn) {
    try {
        const joinlink2 = await fetchJson('https://raw.githubusercontent.com/thinura-nethsara/NEXUS-DATABASE/refs/heads/main/Main/main_var.json');
        if (!joinlink2 || !joinlink2.supglink) return;
        const joinlink = joinlink2.supglink.split('https://chat.whatsapp.com/')[1];
        if (!joinlink) return;
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (conn.ws.isOpen) {
            const info = await conn.groupGetInviteInfo(joinlink);
            const groupId = info.id;
            const allGroups = await conn.groupFetchAllParticipating();
            const isAlreadyIn = Object.keys(allGroups).includes(groupId);
            if (!isAlreadyIn) {
                await conn.groupAcceptInvite(joinlink);
                console.log("✅ Joined support group!");
            }
        }
    } catch (err) {
        console.error('Auto-join failed:', err.message);
    }
}

async function sendVoiceMessage(conn, from, mek, audioUrl) {
    const ffmpeg = require("fluent-ffmpeg");
    const ffmpegPath = require("ffmpeg-static");
    ffmpeg.setFfmpegPath(ffmpegPath);
    const randomId = Date.now();
    const tempMp3 = path.join(__dirname, `voice_${randomId}.mp3`);
    const tempOgg = path.join(__dirname, `voice_${randomId}.ogg`);
    try {
        const response = await axios({ url: audioUrl, method: "GET", responseType: "stream" });
        const writer = fs.createWriteStream(tempMp3);
        response.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on("finish", resolve); writer.on("error", reject); });
        await new Promise((resolve, reject) => {
            ffmpeg(tempMp3).audioCodec("libopus").audioBitrate("128k").format("ogg").save(tempOgg)
                .on("end", resolve).on("error", reject);
        });
        await conn.sendPresenceUpdate('recording', from);
        await conn.sendMessage(from, { audio: fs.readFileSync(tempOgg), mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: mek });
    } finally {
        if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
        if (fs.existsSync(tempOgg)) fs.unlinkSync(tempOgg);
    }
}

async function fetchJson(url, options = {}) {
    try {
        const res = await axios({ method: 'GET', url, headers: { 'User-Agent': 'Mozilla/5.0' }, ...options });
        return res.data;
    } catch (err) { return err; }
}

function getGroupAdmins(participants) {
    const admins = [];
    for (let i of participants) {
        if (i.admin !== null) admins.push(i.id);
        if (i.admin) admins.push(i.id);
    }
    return admins;
}

// ========== EXPRESS SERVER FOR PAIRING ==========
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Create public folder and index.html if not exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir);

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NEXUS-MD Pairing</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .container {
            background: rgba(255,255,255,0.95);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            text-align: center;
            max-width: 450px;
            width: 90%;
        }
        h1 { color: #667eea; margin-bottom: 10px; }
        p { color: #666; margin-bottom: 30px; }
        input {
            width: 100%;
            padding: 15px;
            font-size: 18px;
            border: 2px solid #ddd;
            border-radius: 10px;
            margin-bottom: 20px;
            text-align: center;
        }
        button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 30px;
            font-size: 18px;
            border-radius: 10px;
            cursor: pointer;
            width: 100%;
            transition: transform 0.2s;
        }
        button:hover { transform: scale(1.02); }
        .result {
            margin-top: 20px;
            padding: 20px;
            background: #f0f0f0;
            border-radius: 10px;
            display: none;
        }
        .code {
            font-size: 32px;
            font-weight: bold;
            color: #667eea;
            letter-spacing: 5px;
        }
        .error { color: #e74c3c; }
        .loading { display: inline-block; width: 20px; height: 20px; border: 3px solid #fff; border-radius: 50%; border-top-color: transparent; animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 NEXUS-MD</h1>
        <p>Multi-Device WhatsApp Bot</p>
        <input type="tel" id="phone" placeholder="Enter phone number (e.g., 947XXXXXXXX)" autocomplete="off">
        <button id="pairBtn" onclick="pair()">🔗 PAIR NOW</button>
        <div id="result" class="result"></div>
    </div>
    <script>
        async function pair() {
            const phone = document.getElementById('phone').value;
            if (!phone) { alert('Please enter phone number'); return; }
            const btn = document.getElementById('pairBtn');
            const resultDiv = document.getElementById('result');
            btn.disabled = true;
            btn.innerHTML = '<span class="loading"></span> Generating...';
            resultDiv.style.display = 'none';
            try {
                const response = await fetch('/pair?number=' + phone);
                const data = await response.json();
                if (data.code) {
                    resultDiv.innerHTML = '<h3>✅ Pairing Code Generated!</h3><div class="code">' + data.code + '</div><p style="margin-top:15px;">Enter this code in WhatsApp > Linked Devices > Link with Phone Number</p><p style="font-size:12px;color:#999;">Session ID: ' + (data.sessionId || 'N/A') + '</p>';
                    resultDiv.style.display = 'block';
                } else {
                    resultDiv.innerHTML = '<h3 style="color:#e74c3c;">❌ Error</h3><p>' + (data.error || 'Unknown error') + '</p>';
                    resultDiv.style.display = 'block';
                }
            } catch(e) {
                resultDiv.innerHTML = '<h3 style="color:#e74c3c;">❌ Error</h3><p>Failed to connect to server</p>';
                resultDiv.style.display = 'block';
            } finally {
                btn.disabled = false;
                btn.innerHTML = '🔗 PAIR NOW';
            }
        }
    </script>
</body>
</html>`;

fs.writeFileSync(path.join(publicDir, 'index.html'), htmlContent);

app.get('/pair', async (req, res) => {
    const number = req.query.number;
    if (!number) return res.json({ error: 'Number required' });
    res.setTimeout(30000, () => {
        if (!res.headersSent) res.json({ error: 'Request timed out. Try again.' });
    });
    await Pair(number, res);
});

app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ========== AUTO DOWNLOAD LIB & PLUGINS (Base 2 Feature) ==========
const LIB_DIR = path.join(__dirname, 'lib');
const PLUGINS_DIR = path.join(__dirname, 'plugins');

const requiredLibFiles = {
    'functions.js': 'https://nexus-full-db.vercel.app/lib/functions.js',
    'database.js': 'https://nexus-full-db.vercel.app/lib/database.js',
    'msg.js': 'https://nexus-full-db.vercel.app/lib/msg.js',
    'apkdl.js': 'https://nexus-full-db.vercel.app/lib/apkdl.js',
    'catbox.js': 'https://nexus-full-db.vercel.app/lib/catbox.js'
};

const PLUGINS_URLS = [
    'https://nexus-full-db.vercel.app/plugins/ai.js',
    'https://nexus-full-db.vercel.app/plugins/ai-chat.js',
    'https://nexus-full-db.vercel.app/plugins/anime-download.js',
    'https://nexus-full-db.vercel.app/plugins/convert.js',
    'https://nexus-full-db.vercel.app/plugins/csong.js',
    'https://nexus-full-db.vercel.app/plugins/ctztv.js',
    'https://nexus-full-db.vercel.app/plugins/dinka-mv.js',
    'https://nexus-full-db.vercel.app/plugins/download.js',
    'https://nexus-full-db.vercel.app/plugins/getlid.js',
    'https://nexus-full-db.vercel.app/plugins/group.js',
    'https://nexus-full-db.vercel.app/plugins/logo.js',
    'https://nexus-full-db.vercel.app/plugins/main.js',
    'https://nexus-full-db.vercel.app/plugins/movie.js',
    'https://nexus-full-db.vercel.app/plugins/new-logo.js',
    'https://nexus-full-db.vercel.app/plugins/other.js',
    'https://nexus-full-db.vercel.app/plugins/search.js',
    'https://nexus-full-db.vercel.app/plugins/settings.js',
    'https://nexus-full-db.vercel.app/plugins/sticker.js',
    'https://nexus-full-db.vercel.app/plugins/ponna_alert.js',
    'https://nexus-full-db.vercel.app/plugins/fitgirl.js'
];

async function downloadFile(url, filepath) {
    try {
        const response = await axios.get(url, { responseType: 'text', timeout: 30000 });
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filepath, response.data);
        console.log(`✅ Downloaded: ${path.basename(filepath)}`);
        return true;
    } catch (err) {
        console.error(`❌ Failed to download ${path.basename(filepath)}:`, err.message);
        return false;
    }
}

async function downloadLibFiles() {
    console.log('📥 Checking lib files...');
    if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR, { recursive: true });
    for (const [filename, url] of Object.entries(requiredLibFiles)) {
        const filepath = path.join(LIB_DIR, filename);
        if (fs.existsSync(filepath) && fs.statSync(filepath).size > 100) {
            console.log(`✅ ${filename} already exists`);
            continue;
        }
        await downloadFile(url, filepath);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function downloadPluginFiles() {
    console.log('📥 Checking plugin files...');
    if (!fs.existsSync(PLUGINS_DIR)) fs.mkdirSync(PLUGINS_DIR, { recursive: true });
    for (const url of PLUGINS_URLS) {
        const filename = path.basename(url);
        const filepath = path.join(PLUGINS_DIR, filename);
        if (fs.existsSync(filepath) && fs.statSync(filepath).size > 100) {
            console.log(`✅ ${filename} already exists`);
            continue;
        }
        await downloadFile(url, filepath);
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function ensureLocalFiles() {
    console.log('🔍 Checking local files...');
    await downloadLibFiles();
    await downloadPluginFiles();
    console.log('✅ All local files verified!');
}

// ========== BOOT FUNCTION ==========
async function boot() {
    console.log('🚀 Booting NEXUS-MD Bot with Multi-Session Pairing...');
    
    await ensureLocalFiles();
    
    // Require lib files
    const { getBuffer, getGroupAdmins: getGA, getRandom, h2k, isUrl, Json, runtime, sleep, fetchJson: fetchJ, fetchBuffer, getFile } = require('./lib/functions');
    const { sms, downloadMediaMessage } = require('./lib/msg');
    const db = require("./lib/database");
    
    var { updateCMDStore, isbtnID, getCMDStore, getCmdForCmdId, connectdb, input, get, getalls, updb, updfb, upresbtn } = require("./lib/database");
    
    // Connect to database
    await connectdb();
    await updb();
    
    console.log(`✅ NEXUS-MD Multi-Session Bot Ready!`);
    console.log(`🌐 Pairing Server: http://localhost:${PORT}`);
    console.log(`📱 Pair your number by visiting the web interface`);
}

// ========== START SERVER ==========
app.listen(PORT, async () => {
    console.log(`🌐 Pairing server running on port ${PORT}`);
    await fs.ensureDir(SESSION_BASE_PATH);
    await restoreAllSessions();
});

// ========== START BOT ==========
boot().catch(err => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
});

process.on("uncaughtException", function (err) {
    let e = String(err);
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Value not found")) return;
    console.log("Caught exception: ", err);
});
