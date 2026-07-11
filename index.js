const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

// Check if the script is run via launchd scheduler and verify the time window (6:00 AM - 6:45 AM)
if (process.argv.includes('--scheduled')) {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    
    // We allow running between 6:00 AM and 6:45 AM
    const isWithinWindow = (currentHour === 6 && currentMinute >= 0 && currentMinute <= 45);
    
    if (!isWithinWindow) {
        console.log(`[${now.toLocaleString()}] ⏸️ Skipping scheduled run: Current time is outside the allowed window (6:00 AM - 6:45 AM).`);
        process.exit(0);
    }
}

// Configuration paths updated to your exact Mac Mini folders
const DUAS_DIR = '/Users/shiraz/whatsapp-bot/dailyposts/2025';
const HADEES_DIR = '/Users/shiraz/whatsapp-bot/dailyposts/sahi-muslim';
const TRACKER_PATH = path.join(__dirname, 'tracker.json');

// ⚠️ CHANGE THESE TO YOUR EXACT WHATSAPP GROUP NAMES AND INDIVIDUAL CONTACT NAMES/PHONE NUMBERS
const TARGET_GROUPS = ["I love my family💓💓💓"];
const TARGET_INDIVIDUALS = []; // Add contact names (e.g. "John Doe") or phone numbers (e.g. "971501234567")

const client = new Client({
    authStrategy: new LocalAuth(),
    // Force a stable WhatsApp Web version so it doesn't freeze on start
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: { 
        headless: true, // Runs invisible in background
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Display QR Code for first time setup
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('👉 Scan the QR code above with WhatsApp to log in.');
});

client.on('loading_screen', (percent, message) => {
    console.log(`Loading WhatsApp Web: ${percent}% - ${message}`);
});

client.on('ready', async () => {
    console.log('✅ Connected to WhatsApp Web successfully!');
    
    try {
        // 1. Load tracker data
        let tracker = { lastHadeesNum: 0, lastDuaNum: 0 };
        if (fs.existsSync(TRACKER_PATH)) {
            tracker = JSON.parse(fs.readFileSync(TRACKER_PATH, 'utf-8'));
        }

        // 2. Scan folders for the next index files using custom filename matchers
        const duaMedia = getNextSequentialFile(DUAS_DIR, tracker.lastDuaNum);
        const hadeesMedia = getNextSequentialFile(HADEES_DIR, tracker.lastHadeesNum);
        
        if (!duaMedia && !hadeesMedia) {
            console.log("⏸️ No new sequential files found in either folder. Exiting.");
            client.destroy();
            return;
        }

        // 3. Grab chats and filter for specific groups and individuals
        const chats = await client.getChats();
        const activeGroups = chats.filter(chat => chat.isGroup && TARGET_GROUPS.includes(chat.name));
        const activeIndividualsByName = chats.filter(chat => !chat.isGroup && TARGET_INDIVIDUALS.includes(chat.name));
        
        let targetChats = [...activeGroups, ...activeIndividualsByName];
        
        // Resolve any specified phone numbers that might not be in recent chats
        for (const target of TARGET_INDIVIDUALS) {
            if (/^\d{7,15}$/.test(target)) {
                const chatId = `${target}@c.us`;
                if (!targetChats.some(c => c.id._serialized === chatId)) {
                    try {
                        const chat = await client.getChatById(chatId);
                        targetChats.push(chat);
                    } catch (err) {
                        console.error(`⚠️ Could not retrieve chat for phone number: ${target}. Make sure it is registered on WhatsApp.`, err);
                    }
                }
            }
        }

        console.log(`Found ${targetChats.length} target chats (Groups: ${activeGroups.length}, Individuals: ${targetChats.length - activeGroups.length}).`);

        // 4. Send images sequentially to the chats found
        for (const chat of targetChats) {
            console.log(`📤 Sending updates to: ${chat.name || chat.id.user}`);
            
            if (duaMedia) {
                await chat.sendMessage(duaMedia, { caption: "Daily Dua" });
                await sleep(2500); // 2.5 second delay to look natural
            }
            if (hadeesMedia) {
                await chat.sendMessage(hadeesMedia, { caption: "Daily Hadees" });
                await sleep(2500);
            }
        }
        
        // 5. Update and save the tracking progress indexes
        if (duaMedia) tracker.lastDuaNum = duaMedia.sentIndex;
        if (hadeesMedia) tracker.lastHadeesNum = hadeesMedia.sentIndex;
        
        fs.writeFileSync(TRACKER_PATH, JSON.stringify(tracker, null, 2));
        console.log(`💾 Progress Saved -> Last Dua Index: ${tracker.lastDuaNum} | Last Hadees Index: ${tracker.lastHadeesNum}`);

    } catch (error) {
        console.error("❌ An error occurred during execution:", error);
    } finally {
        console.log("Shutting down client session.");
        client.destroy();
    }
});

// --- Core Helper Naming & Sequential Logic ---
function getNextSequentialFile(directoryPath, lastSentNum) {
    if (!fs.existsSync(directoryPath)) {
        console.log(`Directory folder not found: ${directoryPath}`);
        return null;
    }

    const files = fs.readdirSync(directoryPath);
    let targetFile = null;
    let targetFileNum = Infinity;
    
    // Check if we are reading the Duas folder or the Hadees folder
    const isDuaFolder = directoryPath.includes('2025');

    for (const file of files) {
        if (file.startsWith('.')) continue; // Skip hidden Mac system files like .DS_Store

        let fileNum = null;

        if (isDuaFolder) {
            // Parses strict dates: DD-MM-YYYY (e.g. 01-02-2025 -> 20250201)
            // Turns date stamps into a clean ascending math value
            const dateMatch = file.match(/(\d{2})-(\d{2})-(\d{4})/);
            if (dateMatch) {
                fileNum = parseInt(`${dateMatch[3]}${dateMatch[2]}${dateMatch[1]}`, 10);
            }
        } else {
            // Hardened Hadees Matcher:
            // 1. Cleans out backslashes so "2\23" behaves like a standard number string "223"
            const cleanedName = file.replace(/\\/g, ''); 
            
            // 2. Extracts the true sequence number right before the "@2x" modifier
            const hadeesMatch = cleanedName.match(/Sahih Muslim\s+(\d+)/i);
            if (hadeesMatch) {
                fileNum = parseInt(hadeesMatch[1], 10);
            }
        }

        // Sequential comparison matching rules (Grabs closest available higher integer)
        if (fileNum !== null && fileNum > lastSentNum && fileNum < targetFileNum) {
            targetFileNum = fileNum;
            targetFile = file;
        }
    }

    if (targetFile) {
        const fullPath = path.join(directoryPath, targetFile);
        const media = MessageMedia.fromFilePath(fullPath);
        media.sentIndex = targetFileNum; 
        console.log(`🎯 Next file picked from ${path.basename(directoryPath)}: "${targetFile}" (Stored Index: ${targetFileNum})`);
        return media;
    }
    
    return null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Clean up hidden browser thread on manual termination (Ctrl + C)
process.on('SIGINT', async () => {
    console.log("\n⚠️ Manual cancellation detected. Safely shutting down Chrome...");
    try {
        await client.destroy();
    } catch (e) {}
    process.exit(0);
});

client.initialize();