# Supabase Backend

Folder ini berisi migration database, RLS policy, Realtime setup, dan Edge Functions.
Semua perubahan schema harus dibuat sebagai migration baru; jangan mengubah production
schema hanya melalui Dashboard tanpa menyimpan migration yang setara.

## Isi folder

### Edge Functions

| Function | Fungsi |
|---|---|
| `ingest` | Menerima traffic metrics dan menjalankan baseline/severity terpusat. |
| `diagnostics` | Menyimpan bandwidth dan hop measurements. |
| `diagnostic-jobs` | API structured job one-click LAN Diagnostics. |
| `traffic-live` | Lifecycle session, snapshot, dan flow persistence. |
| `network-health` | Target Health Watch, latest status, dan transition event. |
| `network-discovery` | Session dan result Discovery yang sementara/bounded. |

Diagnostics, Health Watch, Traffic, dan Discovery memiliki jalur terpisah. Hasil
diagnostics tidak boleh masuk rolling baseline atau severity `ingest`.

### Migrations

Migration mencakup schema awal, auth/RLS, diagnostics, Live Traffic, lock recovery,
network context, node inventory, Health Watch, dan Network Discovery.

## Setup

Dari root repository:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Deploy function sesuai fitur yang digunakan:

```powershell
npx supabase functions deploy ingest
npx supabase functions deploy diagnostics
npx supabase functions deploy diagnostic-jobs
npx supabase functions deploy traffic-live
npx supabase functions deploy network-health
npx supabase functions deploy network-discovery
```

Jangan commit `supabase/.temp`; folder tersebut berisi state lokal project link.

## Access control

- Tabel operasional hanya dapat dibaca profile berstatus `approved`.
- Admin mempunyai policy tambahan untuk approval dan konfigurasi.
- Browser tidak memperoleh service-role key.
- Mutation runner dilakukan melalui endpoint tervalidasi/service role.
- Admin pertama di-seed manual sesuai [AUTH_SETUP.md](../docs/AUTH_SETUP.md).

Sebelum mengubah schema, cocokkan dengan bagian skema di [PRD.md](../docs/PRD.md)
dan aturan RLS pada [AGENTS.md](../docs/AGENTS.md).

