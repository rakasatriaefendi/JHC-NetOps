# Auth & approval setup

## 1. Environment frontend

Salin `frontend/.env.example` menjadi `frontend/.env.local`, lalu isi:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SITE_URL` (contoh lokal: `http://localhost:3000`)

Jangan menaruh service-role key di frontend atau variabel `NEXT_PUBLIC_*`.

## 2. Database dan Auth Supabase

1. Terapkan seluruh migration di `supabase/migrations`.
2. Aktifkan provider Email di Supabase Auth.
3. Tambahkan URL berikut ke daftar Auth Redirect URLs:
   - `http://localhost:3000/auth/callback`
   - URL production dengan path `/auth/callback`

## 3. Seed admin pertama secara manual

Register akun admin dari UI terlebih dahulu. Setelah row `profiles` dibuat oleh trigger,
jalankan SQL berikut secara manual melalui Supabase SQL Editor dengan email yang benar:

```sql
update public.profiles
set
  role = 'admin',
  status = 'approved',
  approved_at = now(),
  approved_by = null
where email = 'admin@example.com';
```

Pastikan tepat satu row berubah. Tidak ada logic auto-admin di aplikasi.

## 4. Verifikasi alur

1. Register akun baru (default role Viewer, status Menunggu persetujuan).
2. Konfirmasi email jika Email Confirmations aktif.
3. Viewer harus diarahkan ke `/pending` dan tidak dapat membaca tabel operasional.
4. Admin membuka `/admin`, memilih role **Admin / Operator / Viewer** dan status
   akses **Menunggu persetujuan / Aktif / Ditangguhkan** secara terpisah.
5. Label status tersebut dipetakan ke nilai kompatibel `pending`, `approved`, dan
   `rejected`; rename schema tidak diperlukan.
6. User Aktif dapat membuka dashboard sesuai role; user Menunggu/Ditangguhkan
   tetap diarahkan ke `/pending`.
