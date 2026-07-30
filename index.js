import crypto from 'crypto';
if (!globalThis.crypto) {
    globalThis.crypto = crypto;
}

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import baileys from '@whiskeysockets/baileys';
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;
import axios from 'axios';
import FormData from 'form-data';

// Environment Variables
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const targetBots = (process.env.TARGET_BOT_IDS || "").split(',').map(b => b.trim());

const fbPageId = process.env.FB_PAGE_ID;
const fbAccessToken = process.env.FB_PAGE_ACCESS_TOKEN;
const waChannelJid = process.env.WA_CHANNEL_JID;

// ১. ফেসবুক পেজে পোস্ট
async function postToFacebook(imageBuffer, caption) {
    if (!fbPageId || !fbAccessToken) {
        console.log("⚠️ Facebook Credentials missing, skipping FB post.");
        return;
    }
    try {
        const formData = new FormData();
        formData.append('access_token', fbAccessToken);
        formData.append('message', caption);

        if (imageBuffer) {
            formData.append('source', imageBuffer, { filename: 'tender_banner.jpg' });
            await axios.post(
                `https://graph.facebook.com/v19.0/${fbPageId}/photos`,
                formData,
                { headers: formData.getHeaders() }
            );
        } else {
            await axios.post(
                `https://graph.facebook.com/v19.0/${fbPageId}/feed`,
                { message: caption, access_token: fbAccessToken }
            );
        }
        console.log('✅ FB Page: Posted Successfully!');
    } catch (err) {
        console.error('❌ FB Page Error:', err.response?.data || err.message);
    }
}

// ২. হোয়াটসঅ্যাপ চ্যানেলে পোস্ট
async function postToWhatsApp(waSock, imageBuffer, caption) {
    if (!waChannelJid || !waSock) {
        console.log("⚠️ WA Channel JID or Socket missing, skipping WA post.");
        return;
    }
    try {
        if (imageBuffer) {
            await waSock.sendMessage(waChannelJid, {
                image: imageBuffer,
                caption: caption
            });
        } else {
            await waSock.sendMessage(waChannelJid, { text: caption });
        }
        console.log('✅ WA Channel: Posted Successfully!');
    } catch (err) {
        console.error('❌ WA Channel Error:', err.message);
    }
}

// ৩. হোয়াটসঅ্যাপ কানেক্টর (ম্যাক্সিমাম ৩টি ট্রাই করবে)
function connectWhatsApp(retryCount = 0) {
    return new Promise(async (resolve, reject) => {
        if (retryCount >= 3) {
            return reject(new Error("WhatsApp Failed to connect after 3 attempts. Proceeding without WA."));
        }
        try {
            const { state, saveCreds } = await useMultiFileAuthState('./wa_session');
            const waSock = makeWASocket({
                auth: state,
                browser: ["Windows", "Chrome", "10.0"],
                connectTimeoutMs: 20000,
                defaultQueryTimeoutMs: 20000,
                keepAliveIntervalMs: 10000
            });

            waSock.ev.on('creds.update', saveCreds);

            waSock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'open') {
                    console.log('✅ WhatsApp Authenticated!');
                    resolve(waSock);
                } else if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`⚠️ WA Connection Closed (Status: ${statusCode}). Retrying ${retryCount + 1}/3...`);
                    
                    if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                        reject(new Error("WA Session Logged Out / Invalid."));
                    } else {
                        setTimeout(() => {
                            connectWhatsApp(retryCount + 1).then(resolve).catch(reject);
                        }, 3000);
                    }
                }
            });
        } catch (e) {
            reject(e);
        }
    });
}

// ৪. মেইন প্রসেস
async function main() {
    console.log("🚀 Forwarder Started...");

    // ১. Telegram Start
    const tgClient = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
    await tgClient.connect();
    console.log("✅ Telegram Connected!");

    // ২. WhatsApp Start
    let waSock = null;
    try {
        waSock = await connectWhatsApp();
    } catch (e) {
        console.error("❌ WhatsApp Skip:", e.message);
    }

    const oneHourAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    let newPostsFound = 0;

    for (const botUsername of targetBots) {
        if (!botUsername) continue;
        try {
            console.log(`🔍 Checking ${botUsername}...`);
            const messages = await tgClient.getMessages(botUsername, { limit: 3 });

            for (const msg of messages) {
                if (msg.date > oneHourAgo) {
                    console.log(`📩 New message found from ${botUsername}!`);
                    newPostsFound++;

                    let imageBuffer = null;
                    if (msg.media) {
                        imageBuffer = await tgClient.downloadMedia(msg.media);
                    }

                    const caption = msg.message || "";

                    // ফেসবুকে পোস্ট
                    await postToFacebook(imageBuffer, caption);

                    // হোয়াটসঅ্যাপে পোস্ট
                    if (waSock) {
                        await postToWhatsApp(waSock, imageBuffer, caption);
                    }
                }
            }
        } catch (e) {
            console.error(`Error reading ${botUsername}:`, e.message);
        }
    }

    if (newPostsFound === 0) {
        console.log("ℹ️ No new messages in the last hour.");
    }

    console.log("🎉 Execution finished!");
    process.exit(0);
}

main().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
