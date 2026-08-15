# Hermes AI Agent

Service Flask event-based yang direncanakan untuk membaca event Supabase, meminta
analisis LLM, lalu menulis `ai_summary` kembali ke event.

## Status saat ini

Endpoint `POST /analyze` sudah tersedia sebagai **stub**. Endpoint menerima
`event_id`, tetapi belum mengambil context, memanggil LLM, atau menyimpan hasil.

Contoh response saat ini:

```json
{
  "event_id": "example-id",
  "status": "stub",
  "ai_summary": "Analysis is not implemented yet."
}
```

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e .
cp .env.example .env
```

Environment yang disiapkan:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `LLM_API_URL`
- `LLM_API_KEY`
- `LLM_MODEL`

Nilai LLM baru diperlukan ketika integrasi AI mulai diimplementasikan. Jangan commit
`.env` atau mencetak key ke log.

## Menjalankan

```bash
python app.py
```

Service mendengarkan port `7860`.

## Batas implementasi berikutnya

- Endpoint harus idempotent dan tahan retry/cold start.
- Hanya event severity yang disetujui workflow yang boleh memicu analisis.
- Context harus diambil dari backend; jangan menerima arbitrary prompt dari browser.
- Kegagalan Hermes tidak boleh menghentikan monitoring utama.

