# Historical Supabase Migration Evidence

Folder ini dipertahankan hanya untuk migration historis immutable di
`supabase/migrations/**`. File tersebut merekam schema/RLS/Realtime lama dan
tidak boleh diubah dalam P16.3.

Tidak ada Supabase runtime, SDK, Edge Function, config project, deployment script,
atau compatibility authority aktif. Jangan menjalankan migration atau deploy dari
folder ini. Project remote tetap tidak disentuh sampai P16.4 menerima seluruh
quality gate dan operator menyetujui decommission final.

Rollback source dilakukan dengan release immutable dan runbook fase terkait,
bukan dengan mengaktifkan kembali fallback dalam source current.
