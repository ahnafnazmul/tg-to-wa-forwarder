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
import fs from 'fs';

// Environment Variables
const apiId = parseInt(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");
const targetBots = (process.env.TARGET_BOT_IDS || "").split(',').map(b => b.trim());

const fbPageId = process.env.FB_PAGE_ID;
const fbAccessToken = process.env.FB_PAGE_ACCESS_TOKEN;
const waChannelJid = process.env.WA_CHANNEL_JID;

const LAST_IDS_FILE = './last_ids.json';

// ১. শেষ ফরোয়ার্ড করা মেসেজের ID ট্র্যাক রাখার ফাংশন
function getLastProcessedIds() {
    try {
        if (fs.existsSync(LAST_IDS_FILE)) {
            const data = fs.readFileSync(LAST_IDS_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.error("Error reading last_ids.json:", e.message);
    }
    return {};
}

function saveLastProcessedIds(ids) {
    try {
        fs.writeFileSync(LAST_IDS_FILE, JSON.stringify(ids, null, 2));
    } catch (e) {
        console.error("Error saving last_ids.json:", e.message);
    }
}

// ২. ফেসবুক পেজে পোস্ট
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

// ৩. হোয়াটসঅ্যাপ কানেক্টর
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

    const lastIds = getLastProcessedIds();
    let totalNewPosts = 0;

    for (const botUsername of targetBots) {
        if (!botUsername) continue;
        try {
            console.log(`🔍 Checking ${botUsername}...`);
            const lastMsgId = lastIds[botUsername] || 0;
            
            // সর্বশেষ ৫টি মেসেজ আনা হচ্ছে
            const messages = await tgClient.getMessages(botUsername, { limit: 5 });
            
            // মেসেজগুলো পুরনো থেকে নতুন ক্রমানুসারে প্রসেস করা হবে
            const newMessages = messages
                .filter(msg => msg.id > lastMsgId)
                .sort((a, b) => a.id - b.id);

            if (newMessages.length > 0) {
                console.log(`📩 Found ${newMessages.length} unforwarded message(s) from ${botUsername}!`);

                for (const msg of newMessages) {
                    let imageBuffer = null;
                    if (msg.media) {
                        imageBuffer = await tgClient.downloadMedia(msg.media);
                    }

                    const caption = msg.message || "";

                    // ফেসবুকে পোস্ট
                    await postToFacebook(imageBuffer, caption);

                    // হোয়াটসঅ্যাপে পোস্ট
                    if (waSock && waChannelJid) {
                        try {
                            if (imageBuffer) {
                                await waSock.sendMessage(waChannelJid, { image: imageBuffer, caption: caption });
                            } else {
                                await waSock.sendMessage(waChannelJid, { text: caption });
                            }
                            console.log('✅ WA Channel: Posted Successfully!');
                        } catch (e) {
                            console.error('❌ WA Error:', e.message);
                        }
                    }

                    // লাস্ট মেসেজ ID আপডেট করা
                    lastIds[botUsername] = msg.id;
                    totalNewPosts++;
                }
            } else {
                console.log(`ℹ️ No new unforwarded messages from ${botUsername}.`);
            }
        } catch (e) {
            console.error(`Error reading ${botUsername}:`, e.message);
        }
    }

    // স্টেট সেভ করা
    saveLastProcessedIds(lastIds);

    if (totalNewPosts === 0) {
        console.log("ℹ️ No new messages found to forward.");
    } else {
        console.log(`🎉 Total ${totalNewPosts} new message(s) forwarded successfully!`);
    }

    process.exit(0);
}

main().catch(err => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
