# Hermes — Scaffold Analisis yang Belum Aktif

Hermes adalah scaffold Flask untuk eksplorasi analisis event. Ia **belum menjadi
bagian runtime production NetOps**. `POST /analyze` masih menghasilkan hasil stub;
ia tidak membaca/menulis application persistence dan tidak memanggil model.

Dashboard, Local Auth, Health/SNMP, runner control, dan Traffic tidak memerlukan
proses Hermes. Jangan menambahkannya ke PM2/systemd hanya untuk menjalankan
aplikasi utama.

## Eksperimen development

Dari folder `hermes-agent`, gunakan environment lokal terpisah:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
.venv/bin/python -m flask --app hermes_agent.app run --host 127.0.0.1 --port 7860
```

Lihat [pyproject.toml](pyproject.toml) untuk dependency dan [app.py](app.py) untuk
kontrak stub. Entrypoint `app.py` sendiri bind ke `0.0.0.0:7860`; command di atas
memilih loopback secara eksplisit untuk eksperimen lokal. Ia bukan setup layanan
AI yang siap diterima operator. Jangan mengirim data rumah sakit/credential
ke endpoint eksperimen.

## Batas sebelum dikembangkan lebih lanjut

Integrasi selanjutnya memerlukan scope tersendiri: backend lokal terautentikasi,
context bounded dan disanitasi, authorization, idempotency, serta penanganan
kegagalan yang tidak menghentikan monitoring utama. Jangan menerima prompt bebas
dari browser atau menjadikan output model sebagai otorisasi operasi jaringan.

Secret provider/model, bila kelak dibutuhkan, harus berada server-side dalam
konfigurasi lokal yang tidak dicetak atau di-commit. Tidak ada remote database
transport atau authority alternatif yang boleh diaktifkan sebagai jalan pintas.

Kembali ke [peta komponen utama](../README.md) untuk runtime yang aktif.
