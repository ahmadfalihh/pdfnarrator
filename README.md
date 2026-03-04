# 📹 PDF-to-Video Narrator (CLI + Cloud)

Konversi file PDF menjadi video narasi AI 1080p secara otomatis. Upload ke Google Drive & YouTube dengan metadata SEO (Judul, Deskripsi, Tags) hasil generate Gemini.

## 🚀 Cara Pakai

### Mode Cloud (GitHub Actions — PC tidak perlu nyala)

1. **Push file PDF** ke folder `input/` di repo ini
2. **GitHub Actions** otomatis berjalan dan memproses
3. **Download** hasilnya dari tab **Actions → Artifacts**

### Mode Lokal (PC / Terminal)

```bash
npm install                    # Install dependencies
node process.js --setup        # Download Poppler (Windows only, sekali saja)
node process.js --auth         # Login Google (sekali saja)
node process.js                # Jalankan proses
```

## ⚙️ Setup GitHub Secrets

Buka **Settings → Secrets and variables → Actions → New repository secret**:

| Secret Name | Isi |
|---|---|
| `GEMINI_KEY_1` | API Key Gemini utama |
| `GEMINI_KEY_2` | API Key Gemini cadangan 1 |
| `GEMINI_KEY_3` | API Key Gemini cadangan 2 |
| `GOOGLE_CREDENTIALS` | Isi file `credentials.json` (paste seluruh JSON) |
| `GOOGLE_TOKEN` | Isi file `google_token.json` (paste seluruh JSON) |

Opsional: **Settings → Variables → Actions** (Variables, bukan Secrets):

| Variable Name | Default |
|---|---|
| `NARRATION_STYLE` | Profesional & Formal |
| `NARRATOR_VOICE` | Zephyr |
| `SLIDE_DELAY` | 10 |
| `YOUTUBE_PRIVACY` | private |
| `DRIVE_FOLDER_ID` | (kosong = root drive) |

## 📁 Struktur

```
input/         ← Taruh PDF di sini
input/done/    ← PDF yang sudah selesai diproses
output/        ← Hasil video MP4 1080p
.env           ← Konfigurasi lokal
credentials.json ← Google OAuth (Desktop App)
```
