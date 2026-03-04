#!/usr/bin/env node
/**
 * ===================================================================
 *  PDF-to-Video Narrator — Node.js CLI (Background Processing)
 * ===================================================================
 *  node process.js              → Render + Upload semua
 *  node process.js --render-only → Render saja (tanpa upload YT)
 *  node process.js --upload-youtube → Upload YT saja (pakai jeda anti-bot)
 *  node process.js --setup      → Download Poppler Windows
 *  node process.js --auth       → Login Google
 * ===================================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');

// ============================
//  CONFIG FROM .env
// ============================
const CONFIG = {
    geminiKeys: [
        process.env.GEMINI_KEY_1,
        process.env.GEMINI_KEY_2,
        process.env.GEMINI_KEY_3,
    ].filter(k => k && k.trim() && k !== 'your_gemini_api_key_here'),
    narrationStyle: process.env.NARRATION_STYLE || 'Profesional & Formal',
    narratorVoice: process.env.NARRATOR_VOICE || 'Zephyr',
    slideDelay: parseInt(process.env.SLIDE_DELAY) || 15,
    uploadDrive: process.env.UPLOAD_DRIVE === 'true',
    uploadYoutube: process.env.UPLOAD_YOUTUBE === 'true',
    driveFolderId: process.env.DRIVE_FOLDER_ID || '',
    youtubeChannelId: process.env.YOUTUBE_CHANNEL_ID || '',
    youtubePrivacy: process.env.YOUTUBE_PRIVACY || 'public',
    ytUploadDelayMin: parseInt(process.env.YT_UPLOAD_DELAY_MINUTES) || 60,
};

const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');
const DONE_DIR = path.join(INPUT_DIR, 'done');
const TEMP_DIR = path.join(__dirname, '.tmp_processing');
const TOKEN_PATH = path.join(__dirname, 'google_token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const POPPLER_DIR = path.join(__dirname, 'poppler');
const STATUS_PATH = path.join(__dirname, 'status.json');

// ============================
//  LOGGING
// ============================
const ts = () => new Date().toLocaleTimeString('id-ID');
const log = (m) => console.log(`[${ts()}] ${m}`);
const logOK = (m) => console.log(`[${ts()}] ✅ ${m}`);
const logWarn = (m) => console.log(`[${ts()}] ⚠️  ${m}`);
const logErr = (m) => console.error(`[${ts()}] ❌ ${m}`);
const logStep = (m) => console.log(`[${ts()}] 🔄 ${m}`);

// ============================
//  HELPERS
// ============================
function ensureDirs() {
    [INPUT_DIR, OUTPUT_DIR, DONE_DIR, TEMP_DIR].forEach(d => {
        if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const follow = (u) => {
            const proto = u.startsWith('https') ? https : http;
            proto.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return follow(res.headers.location);
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
                file.on('error', reject);
            }).on('error', reject);
        };
        follow(url);
    });
}

// ============================
//  STATUS.JSON (Live Report)
// ============================
function readStatus() {
    try { if (fs.existsSync(STATUS_PATH)) return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')); } catch (e) { }
    return { lastUpdated: '', phase: 'idle', videos: [], renderProgress: { done: 0, total: 0 }, ytProgress: { done: 0, total: 0, nextUploadAt: '' } };
}
function writeStatus(data) {
    data.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATUS_PATH, JSON.stringify(data, null, 2));
}
function gitAutoCommit(msg) {
    try {
        execSync('git add status.json input/done/ 2>&1', { cwd: __dirname, encoding: 'utf8', timeout: 15000 });
        execSync(`git commit -m "${msg}" --allow-empty 2>&1`, { cwd: __dirname, encoding: 'utf8', timeout: 15000 });
        execSync('git push 2>&1', { cwd: __dirname, encoding: 'utf8', timeout: 30000 });
    } catch (e) { /* not fatal — might not be a git repo */ }
}

// ============================
//  POPPLER SETUP (Windows)
// ============================
async function setupPoppler() {
    const pdftoppmPath = path.join(POPPLER_DIR, 'Library', 'bin', 'pdftoppm.exe');
    if (fs.existsSync(pdftoppmPath)) { logOK('Poppler sudah terinstall.'); return true; }
    log('Mengunduh Poppler for Windows (portable)...');
    const zipUrl = 'https://github.com/oschwartz10612/poppler-windows/releases/download/v24.08.0-0/Release-24.08.0-0.zip';
    const zipPath = path.join(__dirname, 'poppler_download.zip');
    try {
        await downloadFile(zipUrl, zipPath);
        logOK('Download selesai. Mengekstrak...');
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${__dirname}' -Force"`, { timeout: 60000 });
        const extracted = fs.readdirSync(__dirname).filter(f => f.startsWith('poppler-') && fs.statSync(path.join(__dirname, f)).isDirectory());
        if (extracted.length > 0) {
            if (fs.existsSync(POPPLER_DIR)) fs.rmSync(POPPLER_DIR, { recursive: true, force: true });
            fs.renameSync(path.join(__dirname, extracted[0]), POPPLER_DIR);
        }
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        logOK('Poppler berhasil diinstall!');
        return true;
    } catch (e) {
        logErr(`Gagal setup Poppler: ${e.message}`);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        return false;
    }
}

function findPdftoppm() {
    const bundled = path.join(POPPLER_DIR, 'Library', 'bin', 'pdftoppm.exe');
    if (fs.existsSync(bundled)) return bundled;
    const cmd = process.platform === 'win32' ? 'where pdftoppm' : 'which pdftoppm';
    try { const r = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); if (r) return r.split('\n')[0].trim(); } catch (e) { }
    return null;
}

// ============================
//  GEMINI API + ROTATION + BACKOFF
// ============================
let currentKeyIndex = 0;
async function callGemini(model, payload, retryCount = 0) {
    if (CONFIG.geminiKeys.length === 0) throw new Error('Tidak ada API Key Gemini.');
    const maxRetries = CONFIG.geminiKeys.length * 3;
    const key = CONFIG.geminiKeys[currentKeyIndex % CONFIG.geminiKeys.length];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.status === 429) {
            currentKeyIndex++;
            if (retryCount < maxRetries) {
                const w = Math.min(CONFIG.slideDelay * 2, 60);
                logWarn(`429 Key #${(currentKeyIndex - 1) % CONFIG.geminiKeys.length + 1}. Rotasi. Tunggu ${w}s...`);
                await delay(w * 1000);
                return callGemini(model, payload, retryCount + 1);
            }
            throw new Error('Semua API Key kena rate limit.');
        }
        if (!res.ok) { const e = await res.text(); throw new Error(`HTTP ${res.status}: ${e.substring(0, 200)}`); }
        return await res.json();
    } catch (err) {
        if (retryCount < maxRetries && !err.message.includes('Semua API')) {
            const b = Math.min(5000 * Math.pow(2, retryCount), 60000);
            logWarn(`${err.message}. Retry ${b / 1000}s...`);
            await delay(b); currentKeyIndex++;
            return callGemini(model, payload, retryCount + 1);
        }
        throw err;
    }
}

// ============================
//  GOOGLE OAUTH
// ============================
async function getOAuth2Client() {
    if (!fs.existsSync(CREDENTIALS_PATH)) { logWarn('credentials.json tidak ada.'); return null; }
    const { google } = require('googleapis');
    const creds = (JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))).installed || (JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))).web;
    if (!creds) { logErr('credentials.json format salah.'); return null; }
    const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:3847/oauth2callback');
    if (fs.existsSync(TOKEN_PATH)) {
        const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        oauth.setCredentials(tokens);
        if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
            try { const { credentials: r } = await oauth.refreshAccessToken(); oauth.setCredentials(r); fs.writeFileSync(TOKEN_PATH, JSON.stringify(r, null, 2)); logOK('Token refreshed.'); }
            catch (e) { logWarn('Token expired. Jalankan --auth'); return null; }
        }
        return oauth;
    }
    return null;
}

async function authenticateGoogle() {
    if (!fs.existsSync(CREDENTIALS_PATH)) { logErr('credentials.json tidak ada!'); process.exit(1); }
    const { google } = require('googleapis');
    const openBrowser = (await import('open')).default;
    const creds = (JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))).installed || (JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'))).web;
    const oauth = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:3847/oauth2callback');
    const authUrl = oauth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'], prompt: 'consent' });
    log(`Buka URL:\n${authUrl}\n`);
    return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
            const code = new URL(req.url, 'http://localhost:3847').searchParams.get('code');
            if (code) {
                const { tokens } = await oauth.getToken(code); oauth.setCredentials(tokens);
                fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
                res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
                res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f172a;color:white"><h1>✅ Berhasil!</h1><p>Tutup tab ini.</p></body></html>');
                logOK('Token disimpan.'); server.close(); resolve(oauth);
            }
        });
        server.listen(3847, () => openBrowser(authUrl).catch(() => logWarn('Buka URL manual.')));
    });
}

// ============================
//  PDF TO IMAGES
// ============================
async function pdfToImages(pdfPath, outputDir) {
    const pdftoppm = findPdftoppm();
    if (!pdftoppm) throw new Error('Poppler belum terinstall');
    logStep('PDF → PNG (Poppler)...');
    execSync(`"${pdftoppm}" -png -r 200 "${pdfPath}" "${path.join(outputDir, 'slide')}"`, { timeout: 300000, encoding: 'utf8' });
    const files = fs.readdirSync(outputDir).filter(f => f.startsWith('slide') && f.endsWith('.png')).sort();
    logOK(`${files.length} halaman.`);
    return files.map(f => path.join(outputDir, f));
}

// ============================
//  PCM → WAV
// ============================
function pcmToWavFile(b64, out, sr = 24000) {
    const pcm = Buffer.from(b64, 'base64');
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
    fs.writeFileSync(out, Buffer.concat([h, pcm]));
}

// ============================
//  RENDER VIDEO (FFMPEG)
// ============================
async function renderVideo(slides, outputPath) {
    const ffmpeg = require('fluent-ffmpeg');
    ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);
    const concatDir = path.join(TEMP_DIR, 'segments');
    if (!fs.existsSync(concatDir)) fs.mkdirSync(concatDir, { recursive: true });
    logStep('Rendering video...');
    const segPaths = [];
    for (let i = 0; i < slides.length; i++) {
        const s = slides[i], segP = path.join(concatDir, `seg_${String(i).padStart(3, '0')}.mp4`);
        segPaths.push(segP);
        if (fs.existsSync(segP)) fs.unlinkSync(segP);
        logStep(`  Slide ${i + 1}/${slides.length}...`);
        await new Promise((resolve, reject) => {
            let cmd = ffmpeg();
            if (s.audioPath && fs.existsSync(s.audioPath)) {
                cmd.input(s.imagePath).inputOptions(['-loop', '1']).input(s.audioPath)
                    .outputOptions(['-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac', '-b:a', '192k', '-pix_fmt', 'yuv420p',
                        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0f172a', '-shortest']);
            } else {
                cmd.input(s.imagePath).inputOptions(['-loop', '1']).input('anullsrc=r=44100:cl=stereo').inputFormat('lavfi')
                    .outputOptions(['-c:v', 'libx264', '-tune', 'stillimage', '-c:a', 'aac', '-pix_fmt', 'yuv420p',
                        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0f172a', '-t', String(s.duration || 4), '-shortest']);
            }
            cmd.output(segP).on('end', resolve).on('error', reject).run();
        });
    }
    logStep('Menggabungkan segmen...');
    const concatFile = path.join(TEMP_DIR, 'concat.txt');
    fs.writeFileSync(concatFile, segPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    await new Promise((resolve, reject) => {
        ffmpeg().input(concatFile).inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions(['-c:v', 'libx264', '-c:a', 'aac', '-movflags', '+faststart'])
            .output(outputPath).on('end', resolve).on('error', reject).run();
    });
    logOK(`Video: ${outputPath}`);
}

// ============================
//  UPLOAD DRIVE
// ============================
async function uploadToDrive(auth, filePath, fileName) {
    const { google } = require('googleapis');
    const drive = google.drive({ version: 'v3', auth });
    const meta = { name: fileName };
    if (CONFIG.driveFolderId) meta.parents = [CONFIG.driveFolderId];
    logStep(`Drive: ${fileName}...`);
    const res = await drive.files.create({ resource: meta, media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) }, fields: 'id,webViewLink' });
    logOK(`Drive OK. ID: ${res.data.id}`);
    return res.data;
}

// ============================
//  UPLOAD YOUTUBE
// ============================
async function uploadToYouTube(auth, filePath, seo, pdfName) {
    const { google } = require('googleapis');
    const yt = google.youtube({ version: 'v3', auth });
    const title = (seo?.title || `Narasi - ${pdfName}`).substring(0, 100);
    const desc = seo?.description || 'Video presentasi AI.';
    const tags = (seo?.tags || ['Presentasi', 'AI', 'PDF']).slice(0, 20);
    logStep(`YouTube: "${title.substring(0, 50)}..."...`);
    const res = await yt.videos.insert({
        part: 'snippet,status',
        requestBody: { snippet: { title, description: desc, tags, categoryId: '27' }, status: { privacyStatus: CONFIG.youtubePrivacy, selfDeclaredMadeForKids: false } },
        media: { body: fs.createReadStream(filePath) }
    });
    logOK(`YouTube OK! ID: ${res.data.id} → https://youtube.com/watch?v=${res.data.id}`);
    return res.data;
}

// ============================
//  SEO METADATA
// ============================
async function generateSEO(allTexts) {
    logStep('Generating SEO metadata...');
    const prompt = `Berdasarkan teks presentasi berikut, buatkan metadata YouTube.
1. title: Judul clickbait SEO, max 80 char, bahasa Indonesia.
2. description: Min 500 kata, SEO, hashtag di akhir.
3. tags: Min 15 tag trending Indonesia.
Kembalikan HANYA JSON valid tanpa markdown:
{"title":"...","description":"...","tags":["..."]}

Teks: ${allTexts.join(' ').substring(0, 15000)}`;
    try {
        const res = await callGemini('gemini-2.5-flash', {
            contents: [{ parts: [{ text: prompt }] }],
            systemInstruction: { parts: [{ text: 'Jawab HANYA JSON valid.' }] }
        });
        let raw = res.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        const seo = JSON.parse(raw);
        logOK(`SEO: ${seo.title}`);
        return seo;
    } catch (e) { logWarn(`SEO gagal: ${e.message}`); return null; }
}

// ============================
//  PROCESS SINGLE PDF
// ============================
async function processSinglePDF(pdfPath, auth, status, idx) {
    const pdfName = path.basename(pdfPath, '.pdf');
    const v = status.videos[idx];
    log(`\n${'='.repeat(60)}\n📄 ${pdfName}.pdf\n${'='.repeat(60)}`);
    v.renderStatus = 'rendering'; writeStatus(status);

    const workDir = path.join(TEMP_DIR, pdfName.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
    const imgDir = path.join(workDir, 'images'), audDir = path.join(workDir, 'audio');
    fs.mkdirSync(imgDir, { recursive: true }); fs.mkdirSync(audDir, { recursive: true });

    let imagePaths;
    try { imagePaths = await pdfToImages(pdfPath, imgDir); }
    catch (e) { logErr(`PDF→IMG gagal: ${e.message}`); v.renderStatus = 'error'; writeStatus(status); return; }
    if (!imagePaths.length) { v.renderStatus = 'error'; writeStatus(status); return; }

    const slides = [], allTexts = [];
    for (let i = 0; i < imagePaths.length; i++) {
        logStep(`Slide ${i + 1}/${imagePaths.length}: Narasi...`);
        let script = '', audioPath = null, dur = 4;
        try {
            const b64 = fs.readFileSync(imagePaths[i]).toString('base64');
            const r = await callGemini('gemini-2.5-flash', {
                contents: [{ parts: [{ text: `Anda narator presentasi. Jelaskan GAMBAR SLIDE ini.\nGaya: ${CONFIG.narrationStyle}.\nPanjang 70-100 kata. Bahasa Indonesia.` }, { inlineData: { mimeType: 'image/png', data: b64 } }] }],
                systemInstruction: { parts: [{ text: 'Hanya skrip narasinya.' }] }
            });
            script = r.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
            if (script.length < 20) script = `Slide ${i + 1} menampilkan informasi penting yang perlu kita perhatikan.`;
            logOK(`  ${script.substring(0, 70)}...`);
        } catch (e) { logWarn(`  Narasi gagal: ${e.message}`); script = `Slide ${i + 1} menampilkan informasi penting.`; }
        allTexts.push(script);

        logStep(`Slide ${i + 1}/${imagePaths.length}: TTS...`);
        try {
            const r = await callGemini('gemini-2.5-flash-preview-tts', {
                contents: [{ parts: [{ text: script }] }],
                generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: CONFIG.narratorVoice } } } },
                model: 'gemini-2.5-flash-preview-tts'
            });
            const ad = r.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (ad) {
                const wav = path.join(audDir, `s${String(i).padStart(3, '0')}.wav`);
                pcmToWavFile(ad, wav); audioPath = wav;
                try {
                    const fp = require('@ffmpeg-installer/ffmpeg').path.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
                    if (fs.existsSync(fp)) dur = parseFloat(execSync(`"${fp}" -v error -show_entries format=duration -of csv=p=0 "${wav}"`, { encoding: 'utf8', timeout: 10000 }).trim()) || 4;
                } catch (e) { }
                logOK(`  Audio: ${dur.toFixed(1)}s`);
            }
        } catch (e) { logWarn(`  TTS gagal: ${e.message}`); }
        slides.push({ imagePath: imagePaths[i], audioPath, script, duration: dur });
        if (i < imagePaths.length - 1) { logStep(`  Jeda ${CONFIG.slideDelay}s...`); await delay(CONFIG.slideDelay * 1000); }
    }

    // SEO
    const seo = await generateSEO(allTexts);
    v.seo = seo; writeStatus(status);

    // Render
    const outFile = `Narasi_${pdfName}.mp4`, outPath = path.join(OUTPUT_DIR, outFile);
    try { await renderVideo(slides, outPath); }
    catch (e) { logErr(`Render gagal: ${e.message}`); v.renderStatus = 'error'; writeStatus(status); return; }

    v.renderStatus = 'done'; v.outputFile = outFile; status.renderProgress.done++;
    writeStatus(status); gitAutoCommit(`🎬 Rendered: ${pdfName}`);

    // Drive upload (immediate)
    if (CONFIG.uploadDrive && auth) {
        try { await uploadToDrive(auth, outPath, outFile); } catch (e) { logErr(`Drive: ${e.message}`); }
    }

    // Move PDF
    try { fs.renameSync(pdfPath, path.join(DONE_DIR, path.basename(pdfPath))); logOK('PDF → done/'); } catch (e) { }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { }
    logOK(`Render selesai: ${pdfName}\n`);
}

// ============================
//  YOUTUBE UPLOAD PHASE (delayed, anti-bot)
// ============================
async function youtubeUploadPhase(auth, status) {
    const baseDelay = CONFIG.ytUploadDelayMin;
    const pending = status.videos.filter(v => v.renderStatus === 'done' && v.ytStatus !== 'uploaded');
    if (!pending.length) { logOK('Tidak ada video untuk upload YT.'); return; }

    status.phase = 'uploading_youtube';
    status.ytProgress.total = status.videos.filter(v => v.renderStatus === 'done').length;
    writeStatus(status);

    log(`\n${'═'.repeat(60)}\n  ▶️  UPLOAD YOUTUBE — ${pending.length} video\n  Jeda: ~${baseDelay} menit (±10 acak, anti-bot)\n${'═'.repeat(60)}\n`);

    for (let i = 0; i < pending.length; i++) {
        const v = pending[i], pdfName = path.basename(v.name, '.pdf');
        const vidPath = path.join(OUTPUT_DIR, v.outputFile || `Narasi_${pdfName}.mp4`);
        if (!fs.existsSync(vidPath)) { logErr(`Video hilang: ${vidPath}`); v.ytStatus = 'error'; writeStatus(status); continue; }

        v.ytStatus = 'uploading'; writeStatus(status); gitAutoCommit(`▶️ Uploading: ${pdfName}`);
        try {
            const yt = await uploadToYouTube(auth, vidPath, v.seo, pdfName);
            v.ytStatus = 'uploaded'; v.ytUrl = `https://youtube.com/watch?v=${yt.id}`; v.ytVideoId = yt.id;
            status.ytProgress.done++; writeStatus(status); gitAutoCommit(`✅ YT: ${pdfName}`);
        } catch (e) { logErr(`YT gagal ${pdfName}: ${e.message}`); v.ytStatus = 'error'; writeStatus(status); }

        // Random delay anti-bot (base ± 10 menit)
        if (i < pending.length - 1) {
            const rnd = Math.floor(Math.random() * 21) - 10; // -10 to +10
            const actualMin = Math.max(10, baseDelay + rnd);
            const nextAt = new Date(Date.now() + actualMin * 60000);
            status.ytProgress.nextUploadAt = nextAt.toISOString();
            writeStatus(status); gitAutoCommit(`⏱ Next: ${nextAt.toLocaleTimeString('id-ID')} (${actualMin}m)`);
            log(`\n⏱  Jeda ${actualMin}m → Upload berikutnya: ${nextAt.toLocaleTimeString('id-ID')}\n`);
            await delay(actualMin * 60000);
        }
    }

    status.phase = 'done'; status.ytProgress.nextUploadAt = '';
    writeStatus(status); gitAutoCommit('🎉 Semua YT upload selesai');
}

// ============================
//  MAIN
// ============================
async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('  📹 PDF-to-Video Narrator — CLI Background Processor');
    console.log('═'.repeat(60) + '\n');

    if (process.argv.includes('--setup')) { await setupPoppler(); process.exit(0); }
    if (process.argv.includes('--auth')) { await authenticateGoogle(); process.exit(0); }

    const renderOnly = process.argv.includes('--render-only');
    const uploadYTOnly = process.argv.includes('--upload-youtube');

    // Mode: upload-youtube only
    if (uploadYTOnly) {
        log('Mode: Upload YouTube (jeda anti-bot)');
        const auth = await getOAuth2Client();
        if (!auth) { logErr('Jalankan --auth dulu.'); process.exit(1); }
        await youtubeUploadPhase(auth, readStatus());
        logOK('Upload YouTube selesai!');
        process.exit(0);
    }

    if (!CONFIG.geminiKeys.length) { logErr('Isi GEMINI_KEY_1 di .env!'); process.exit(1); }
    if (!findPdftoppm()) {
        logWarn('Poppler belum ada. Download otomatis...');
        if (!(await setupPoppler())) { logErr('Jalankan --setup'); process.exit(1); }
    }

    ensureDirs();
    log(`Config: Style=${CONFIG.narrationStyle} Voice=${CONFIG.narratorVoice} Delay=${CONFIG.slideDelay}s Keys=${CONFIG.geminiKeys.length}`);
    log(`Upload: Drive=${CONFIG.uploadDrive} YT=${renderOnly ? 'SKIP' : CONFIG.uploadYoutube} Privacy=${CONFIG.youtubePrivacy}`);

    let auth = null;
    if ((CONFIG.uploadDrive || CONFIG.uploadYoutube) && !renderOnly) {
        auth = await getOAuth2Client();
        if (auth) logOK('Google OAuth OK.');
        else logWarn('Tanpa Google auth. Upload dinonaktifkan.');
    }

    const pdfFiles = fs.readdirSync(INPUT_DIR).filter(f => f.toLowerCase().endsWith('.pdf')).map(f => path.join(INPUT_DIR, f));
    if (!pdfFiles.length) { log('Tidak ada PDF di input/'); process.exit(0); }

    const total = pdfFiles.length;
    log(`\n📋 ${total} PDF ditemukan.\n`);

    // Init status
    const status = readStatus();
    status.phase = 'rendering';
    status.renderProgress = { done: 0, total };
    status.ytProgress = { done: 0, total, nextUploadAt: '' };
    status.videos = pdfFiles.map(f => ({ name: path.basename(f), renderStatus: 'pending', ytStatus: 'pending', ytUrl: null, seo: null, outputFile: null }));
    writeStatus(status); gitAutoCommit(`🚀 Start: ${total} PDF`);

    // Phase 1: Render
    for (let i = 0; i < pdfFiles.length; i++) {
        log(`[${i + 1}/${total}]`);
        try { await processSinglePDF(pdfFiles[i], auth, status, i); }
        catch (e) { logErr(`Fatal: ${e.message}`); status.videos[i].renderStatus = 'error'; writeStatus(status); }
    }
    try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch (e) { }
    logOK(`Render selesai: ${status.renderProgress.done}/${total}`);

    // Phase 2: YouTube upload (delayed)
    if (!renderOnly && CONFIG.uploadYoutube && auth) {
        await youtubeUploadPhase(auth, status);
    } else if (renderOnly) {
        status.phase = 'rendered'; writeStatus(status); gitAutoCommit('🎬 Render done (render-only)');
        log('Untuk upload YT: node process.js --upload-youtube');
    }

    console.log('\n' + '═'.repeat(60));
    logOK('Selesai!');
    console.log('═'.repeat(60) + '\n');
}

main().catch(e => { logErr(e.message); process.exit(1); });
