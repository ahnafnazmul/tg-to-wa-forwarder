const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const input = require("input");

// ⚠️ আপনার টেলিগ্রামের API ID এবং API HASH এখানে বসান
const apiId = 32207561; // উদাহরণ: 28374615 (উদ্ধৃতি চিহ্ন ছাড়া)
const apiHash = "dd8fdbafce1b68daf5941e23e8e99da6"; // উদাহরণ: "a1b2c3d4e5f6..." (উদ্ধৃতি চিহ্নের ভেতর)

async function startSetup() {
    console.log("==========================================");
    console.log("   ১. টেলিগ্রাম সেশন জেনারেটর চালু হচ্ছে...  ");
    console.log("==========================================");

    const stringSession = new StringSession("");
    const tgClient = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
    });

    try {
        await tgClient.start({
            phoneNumber: async () => await input.text("আপনার টেলিগ্রাম ফোন নম্বর (দেশি কোডসহ, যেমন +8801...): "),
            password: async () => await input.text("আপনার ২-স্টেপ ভেরিফিকেশন পাসওয়ার্ড (যদি থাকে): "),
            phoneCode: async () => await input.text("টেলিগ্রামে আসা OTP কোডটি দিন: "),
            onError: (err) => console.log(err),
        });

        console.log("\n✅ আপনার TELEGRAM_SESSION সফলভাবে জেনারেট হয়েছে!");
        console.log("----------------------------------------------------------------------------------");
        console.log(tgClient.session.save());
        console.log("----------------------------------------------------------------------------------");
        console.log("👆 ওপরের কোডটি কপি করে আপনার GitHub Secrets-এ 'TELEGRAM_SESSION' নামে সেভ করুন।\n");

        await tgClient.disconnect();
    } catch (error) {
        console.error("❌ Telegram Session জেনারেট করতে সমস্যা হয়েছে:", error.message);
    }

    console.log("==========================================");
    console.log("   ২. হোয়াটসঅ্যাপ কানেকশন তৈরি করা হচ্ছে... ");
    console.log("==========================================");

    startWhatsApp();
}

function startWhatsApp() {
    useMultiFileAuthState('./wa_session').then(({ state, saveCreds }) => {
        const waSock = makeWASocket({
            auth: state,
            browser: ["Windows", "Chrome", "10.0"]
        });

        waSock.ev.on('creds.update', saveCreds);

        waSock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            // টার্মিনালে QR Code প্রিন্ট করার লজিক
            if (qr) {
                console.log("\n📱 নিচে থাকা QR Code-টি আপনার ফোনের WhatsApp দিয়ে স্ক্যান করুন:\n");
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    console.log("🔄 কানেক্ট হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন...");
                    startWhatsApp();
                } else {
                    console.log("❌ WhatsApp সেশন বাতিল হয়েছে। wa_session ফোল্ডার ডিলিট করে আবার চেষ্টা করুন।");
                }
            } else if (connection === 'open') {
                console.log("\n🎉 WhatsApp সফলভাবে কানেক্ট ও সিঙ্ক সম্পন্ন হয়েছে!");
                console.log("আপনার 'wa_session' ফোল্ডারে কানেকশন ফাইল তৈরি হয়ে গেছে।\n");
                process.exit(0);
            }
        });
    });
}

startSetup();