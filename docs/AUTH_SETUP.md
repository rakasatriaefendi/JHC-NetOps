# Local Auth & approval setup

Runtime login, registration, logout, dan session resolution memakai backend
loopback serta PostgreSQL lokal. Supabase client tetap ada untuk fitur transisi
Realtime/shadow, tetapi bukan authority identity/session.

## 1. Prasyarat

- `PERSISTENCE_AUTHORITY=local_postgres`.
- `LOCAL_BACKEND_URL` dan `LOCAL_BACKEND_FRONTEND_TOKEN` tersedia hanya bagi
  Next.js server; token tidak boleh memakai prefix `NEXT_PUBLIC_`.
- Migration `010` sudah diterapkan, lalu operator menerapkan migration
  `011_local_auth.sql` pada cluster khusus `16/jhcnetops:5433/jhc_netops`.

Migration 011 membuat credential dan session lokal tanpa menyalin role/status.
Tabel `profiles` tetap menjadi satu-satunya authority role dan approval.

## 2. Registrasi dan approval

Registrasi baru membuat identity lokal dan profile `viewer/pending` dalam satu
transaksi. User diarahkan ke `/pending`. Admin approved tetap mengubah role dan
status melalui `/admin`; tidak ada auto-admin.

Password Supabase tidak dapat diekspor atau dipindahkan. Profil existing tidak
boleh di-claim hanya dengan mengetahui email. Sebelum rollout, operator wajib
menyelesaikan enrollment credential lokal yang ditinjau untuk minimal satu admin
existing. Jangan mengubah profile id, role, status, atau approval metadata untuk
mengakali enrollment.

### Enrollment profil existing oleh operator

Jalankan CLI hanya dari immutable release setelah migration 011 diterapkan. CLI
memerlukan UUID profile dan email yang diharapkan, lalu membaca password dua kali
dari TTY tanpa echo. Password tidak boleh diberikan sebagai argumen atau pipe.

```bash
ROOT=/var/www/jhc/jhc_noc
SHA=<DEPLOYED_SHA>
REL="$ROOT/releases/$SHA"

cd "$REL/backend"
set -a
. "$ROOT/shared/backend/.env"
set +a

npm run auth:enroll-existing -- \
  --profile-id '<EXACT_PROFILE_UUID>' \
  --email '<EXPECTED_PROFILE_EMAIL>'

unset APPLICATION_DATABASE_URL
```

Credential existing ditolak secara default. Rotasi harus eksplisit dengan
menambahkan `--rotate`; operasi tersebut tetap tidak mengubah row `profiles`.
CLI fail closed tanpa TTY interaktif atau bila UUID/email tidak cocok.

## 3. Session dan origin

Browser menerima cookie opaque, host-only, `HttpOnly`, dan `SameSite=Lax`.
Cookie memakai `Secure` pada origin HTTPS publik dan tetap dapat digunakan pada
origin HTTP LAN yang disetujui. Setelah login/register, navigasi ke
`/auth/resolve` memakai GET; helper origin yang sama mempertahankan origin publik
atau LAN dan menolak forwarded host yang tidak dipercaya.

## 4. Verifikasi

1. Login publik berakhir di origin publik; login LAN tetap di origin LAN.
2. Approved menuju `/dashboard`; pending/rejected menuju `/pending`.
3. Logout menghapus session database dan cookie browser.
4. Session expired/tidak dikenal ditolak dan protected layout kembali ke login.
5. Admin approval tetap mempertahankan perlindungan self-demotion dan last-admin.
