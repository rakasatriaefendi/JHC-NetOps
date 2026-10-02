# Hermes AI Agent (Disabled Scaffold)

Hermes adalah scaffold Flask yang belum menjadi bagian runtime production.
`POST /analyze` masih mengembalikan hasil stub dan tidak membaca/menulis
application persistence atau memanggil model.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
python app.py
```

Jika fitur ini dilanjutkan, ia harus memakai backend lokal terautentikasi,
context bounded, dan kontrak idempotent. Jangan menerima arbitrary prompt dari
browser, jangan menambahkan remote database transport, dan jangan membiarkan
kegagalan Hermes menghentikan monitoring utama. Secret LLM tetap lokal dan tidak
boleh dicetak atau di-commit.
