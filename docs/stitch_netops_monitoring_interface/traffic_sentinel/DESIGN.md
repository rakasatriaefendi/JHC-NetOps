---
name: Traffic Sentinel
colors:
  surface: '#101413'
  surface-dim: '#101413'
  surface-bright: '#353a38'
  surface-container-lowest: '#0a0f0e'
  surface-container-low: '#181d1b'
  surface-container: '#1c211f'
  surface-container-high: '#262b29'
  surface-container-highest: '#313634'
  on-surface: '#dfe3e1'
  on-surface-variant: '#bdc9c5'
  inverse-surface: '#dfe3e1'
  inverse-on-surface: '#2d3130'
  outline: '#88938f'
  outline-variant: '#3e4946'
  surface-tint: '#7cd7c3'
  primary: '#7cd7c3'
  on-primary: '#00382f'
  primary-container: '#42a08e'
  on-primary-container: '#003028'
  inverse-primary: '#006b5c'
  secondary: '#c3c6d0'
  on-secondary: '#2d3138'
  secondary-container: '#43474f'
  on-secondary-container: '#b2b5be'
  tertiary: '#ffb4a4'
  on-tertiary: '#581d10'
  tertiary-container: '#cf7a66'
  on-tertiary-container: '#4f160a'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#98f3df'
  primary-fixed-dim: '#7cd7c3'
  on-primary-fixed: '#00201b'
  on-primary-fixed-variant: '#005045'
  secondary-fixed: '#dfe2ec'
  secondary-fixed-dim: '#c3c6d0'
  on-secondary-fixed: '#181c23'
  on-secondary-fixed-variant: '#43474f'
  tertiary-fixed: '#ffdad3'
  tertiary-fixed-dim: '#ffb4a4'
  on-tertiary-fixed: '#3c0801'
  on-tertiary-fixed-variant: '#753224'
  background: '#101413'
  on-background: '#dfe3e1'
  surface-variant: '#313634'
  bg-base: '#14171C'
  border: '#2A2F38'
  text-primary: '#E4E6EA'
  text-secondary: '#9AA1AC'
  text-muted: '#6B7280'
  status-normal: '#4C9A6A'
  status-medium: '#C79A45'
  status-high: '#C67C4E'
  status-critical: '#B0524A'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: '600'
    lineHeight: 32px
  section-label:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '500'
    lineHeight: 24px
  body:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
  meta:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
  data-display:
    fontFamily: JetBrains Mono
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px
---

# DESIGN.md — Design system

Dokumen ini adalah sumber kebenaran untuk token visual project **Network Traffic Monitoring Dashboard**. Dipakai untuk menyamakan hasil desain di Google Stitch/Figma dengan implementasi kode di Next.js (Tailwind config, dsb). Kalau ada perbedaan antara file `.fig` dan dokumen ini, dokumen ini yang jadi acuan final kecuali didiskusikan ulang.

## Prinsip desain

- Tools fungsional untuk dipantau berjam-jam, bukan landing page. Prioritaskan kejelasan & kenyamanan mata di atas dekorasi.
- Hindari gaya "AI slop": tanpa glassmorphism, neumorphism, glow/neon, gradient ungu-biru, drop shadow berlebihan, bentuk blob 3D mengambang.
- Referensi: Linear, Vercel dashboard, Grafana, Datadog.

## Tipografi

| Peran | Font | Catatan |
|---|---|---|
| UI (nav, label, heading, body) | **Inter** | 400 body, 500 label/subheading, 600 heading saja |
| Data (IP, port, timestamp, angka metrik) | **JetBrains Mono** (alternatif: IBM Plex Mono) | Dipakai konsisten untuk semua kolom numerik/teknis |

Type scale — jangan keluar dari skala ini:
- 12px — meta/secondary text
- 14px — body & default isi tabel
- 16px — section label
- 20-22px — page heading

## Warna — dark theme (tema utama)

| Token | Hex | Pemakaian |
|---|---|---|
| `bg-base` | `#14171C` | Background halaman |
| `bg-surface` | `#1C2027` | Card, panel, sidebar |
| `border` | `#2A2F38` | Garis pemisah, border input |
| `text-primary` | `#E4E6EA` | Teks utama |
| `text-secondary` | `#9AA1AC` | Label, teks sekunder |
| `text-muted` | `#6B7280` | Hint, timestamp kecil |
| `accent` | `#3E9C8A` | Link, tombol utama, elemen interaktif |

## Warna — light theme (alternatif)

| Token | Hex | Pemakaian |
|---|---|---|
| `bg-base` | `#F5F4F0` | Background halaman (warm off-white, bukan putih polos) |
| `bg-surface` | `#FFFFFF` | Card, panel |
| `border` | `#E2E0DA` | Garis pemisah |
| `text-primary` | `#1F2328` | Teks utama |
| `text-secondary` | `#5B6169` | Label, teks sekunder |
| `accent` | `#0F6E56` | Link, tombol utama |

## Warna status/severity (dipakai sama di kedua tema, disesuaikan opacity)

| Severity | Hex (dark bg) | Karakter warna |
|---|---|---|
| Normal / Low | `#4C9A6A` | Hijau redup, bukan hijau terang |
| Medium | `#C79A45` | Amber redup |
| High | `#C67C4E` | Oranye kecoklatan |
| Critical | `#B0524A` | Merah tua redup |

Aturan wajib: warna status **selalu dipasangkan dengan icon + label teks**, tidak pernah mengandalkan warna saja (aksesibilitas & konsistensi dengan colorblind user).

## Spacing

Grid dasar 4px. Skala yang dipakai: `4, 8, 12, 16, 24, 32, 48` (px). Jangan pakai angka di luar skala ini untuk padding/margin/gap.

## Radius

- Input, button, badge: `6px`
- Card, panel, modal: `12px`
- Tidak ada elemen dengan radius besar (pill) kecuali badge status.

## Komponen inti (harus reusable, sama persis di semua halaman)

- **Nav item** — sidebar (desktop) / drawer item (mobile), state default/hover/active.
- **Status badge** — pill kecil, warna severity + icon + label singkat.
- **Metric card** — untuk ringkasan Dashboard (throughput, latency, packet loss).
- **Table row** — desktop: baris tabel biasa. Mobile: berubah jadi card ringkas (lihat breakpoint di bawah).
- **Filter chip / dropdown** — untuk filter Traffic & History.
- **Button** — flat, border 1px, tanpa shadow mengambang. Varian: primary (`accent`), secondary (outline), destructive (severity high/critical color).
- **Input/search bar** — flat, border 1px, focus state pakai `accent` sebagai outline tipis.

## Breakpoint & perilaku mobile

- Breakpoint utama: `768px`.
- Di bawah breakpoint: sidebar desktop → hamburger + drawer slide-in dari kiri (style identik dengan sidebar, cuma beda posisi).
- Tabel (Traffic, History) → card-per-row, bukan scroll horizontal maupun font diperkecil.
- Filter row → collapsible panel lewat icon filter.
- Summary cards Dashboard → stack 1 kolom.

## Catatan implementasi

- Kalau dipakai di Tailwind config, jadikan token di atas sebagai `theme.extend.colors` and `theme.extend.fontFamily`, jangan hardcode hex langsung di komponen.
- File `.fig` hasil export Google Stitch tetap harus dicek ulang terhadap tabel warna & tipografi di dokumen ini sebelum dijadikan acuan build — AI design tool kadang sedikit meleset dari instruksi persis.
