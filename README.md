# Add Mass GSuite → Kiro → 9Router

Bot Puppeteer untuk mendaftarkan akun GSuite secara bulk ke provider **kiro** pada 9Router lewat Google OAuth.

## Requirements

- Node.js >= 18
- Google Chrome / Chromium (dibawa oleh `npm install puppeteer`)
- 9Router berjalan di `http://localhost:20128` dengan **Require Login** dimatikan (Settings)

## Instalasi

```bash
npm install
```

## File Akun

`akun.txt` (satu akun per baris, tanpa 2FA):

```
akun1@gmail.com|password123
akun2@gmail.com|password456
```

## Penggunaan

```bash
node bot.js
```

## Alur per Akun

1. `GET /api/oauth/kiro/social-authorize?provider=google` -> `authUrl` + `codeVerifier`
2. Buka `authUrl`. Karena `idp=Google`, halaman auth Kiro langsung lempar ke
   `accounts.google.com` — **tidak ada tombol Google yang perlu diklik**
3. Google: email > Next > password > Next > semua tombol consent
4. Google redirect balik ke `kiro://kiro.kiroAgent/authenticate-success?code=...`
5. `POST /api/oauth/kiro/social-exchange` dengan `{code, codeVerifier, provider:"google"}`
6. Cek `/api/providers`: connection `kiro` baru muncul? Kalau ya, bot me-rename-nya
   ke email akun (9Router memberi nama default "Account N"), lalu baris dihapus dari
   `akun.txt`. Tidak muncul / error > dicatat ke `failed.txt` dengan alasan
7. Browser ditutup, delay 3 detik, lanjut akun berikutnya

## Catatan

- Mode **visible** (bukan headless), Google memblokir headless dengan
  "This browser or app may not be secure".
- Callback `kiro://` tidak bisa dimuat Chrome, jadi `page.url()` **tidak** berubah.
  Kodanya hanya terlihat di event `request` — jangan andalkan `page.url()`.
- Provider OAuth bisa diganti lewat konstanta `PROVIDER` / `SOCIAL_IDP` di `bot.js`
  (kiro + google adalah kombinasi yang tersedia untuk akun Google).
- Kalau bot gagal, tiap tab yang terbuka di-dump (URL + teks) dan screenshot disimpan ke `failed-<n>.png`.
- Kalau bot dihentikan di tengah jalan, akun belum diproses tetap ada di `akun.txt`. Jalankan ulang untuk melanjutkan; akun yang sudah masuk 9Router dilewati otomatis (SKIP).
- Akun yang kena "2-Step Verification" / "Couldn't sign you in" dicatat ke `failed.txt`, tidak macet.

## Disclaimer

DO WITH YOUR OWN RISK. Gunakan hanya untuk akun yang Anda miliki secara sah.
